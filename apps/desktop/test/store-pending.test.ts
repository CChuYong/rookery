import { describe, it, expect, beforeEach } from "vitest";
import { useStore } from "../src/renderer/store/store.js";

describe("pushPending (pending message infra — dormant)", () => {
  beforeEach(() => {
    // Reset connectionEpoch too: pushPending stamps the current epoch (0), so these expectations carry epoch: 0.
    useStore.setState({ pendingBySession: {}, connectionEpoch: 0 });
  });

  it("pushPending appends to pendingBySession", () => {
    useStore.getState().pushPending("s1", { clientMsgId: "c1", text: "hi" });
    expect(useStore.getState().pendingBySession.s1).toEqual([{ clientMsgId: "c1", text: "hi", epoch: 0 }]);
  });

  it("pushPending accumulates multiple items for the same session", () => {
    useStore.getState().pushPending("s1", { clientMsgId: "c1", text: "first" });
    useStore.getState().pushPending("s1", { clientMsgId: "c2", text: "second" });
    expect(useStore.getState().pendingBySession.s1).toEqual([
      { clientMsgId: "c1", text: "first", epoch: 0 },
      { clientMsgId: "c2", text: "second", epoch: 0 },
    ]);
  });

  it("pushPending keeps different sessions isolated", () => {
    useStore.getState().pushPending("s1", { clientMsgId: "c1", text: "hi" });
    useStore.getState().pushPending("s2", { clientMsgId: "c2", text: "there" });
    expect(useStore.getState().pendingBySession.s1).toHaveLength(1);
    expect(useStore.getState().pendingBySession.s2).toHaveLength(1);
  });

  it("master.message reconcile removes the matching pending item from the store", () => {
    useStore.getState().pushPending("s1", { clientMsgId: "c1", text: "q" });
    useStore.getState().pushPending("s1", { clientMsgId: "c2", text: "r" });
    useStore.getState().applyEvent({ type: "master.message", sessionId: "s1", role: "user", content: "q", clientMsgId: "c1" });
    expect(useStore.getState().pendingBySession.s1).toEqual([{ clientMsgId: "c2", text: "r", epoch: 0 }]);
  });

  it("dropPending rolls back the failed send's bubble and leaves other sessions untouched", () => {
    useStore.getState().pushPending("s1", { clientMsgId: "c1", text: "a" });
    useStore.getState().pushPending("s1", { clientMsgId: "c2", text: "b" });
    useStore.getState().pushPending("s2", { clientMsgId: "c3", text: "c" });
    useStore.getState().dropPending("s1", "c1");
    useStore.getState().dropPending("s1", "c2");
    expect(useStore.getState().pendingBySession.s1).toEqual([]);
    expect(useStore.getState().pendingBySession.s2).toEqual([{ clientMsgId: "c3", text: "c", epoch: 0 }]);
  });
});

describe("pendingBySession fallback reconciliation (audit #17)", () => {
  const SID = "s1";
  const echoEvent = (cid: string) => ({ seq: 0, type: "master.message", payload: { type: "master.message", sessionId: SID, role: "user", content: "hi", clientMsgId: cid } });

  beforeEach(() => { useStore.setState({ pendingBySession: {}, logsBySession: {}, connectionEpoch: 0 }); });

  it("seed drops a pending entry whose echo is already committed (lost live echo)", () => {
    useStore.getState().pushPending(SID, { clientMsgId: "c1", text: "hi" });
    useStore.getState().bumpConnectionEpoch(); // reconnect
    useStore.getState().seedHistory(SID, [echoEvent("c1")]);
    expect(useStore.getState().pendingBySession[SID] ?? []).toEqual([]);
  });

  it("seed drops pre-reconnect entries with no committed echo (queued turn lost to a restart)", () => {
    useStore.getState().pushPending(SID, { clientMsgId: "c1", text: "hi" });
    useStore.getState().bumpConnectionEpoch();
    useStore.getState().seedHistory(SID, []); // fresh daemon: nothing persisted
    expect(useStore.getState().pendingBySession[SID] ?? []).toEqual([]);
  });

  it("seed KEEPS a current-epoch entry still awaiting its echo", () => {
    useStore.getState().pushPending(SID, { clientMsgId: "c1", text: "hi" });
    useStore.getState().seedHistory(SID, []); // e.g. session select — same connection
    expect(useStore.getState().pendingBySession[SID]).toHaveLength(1);
  });
});

describe("pendingByWorker (optimistic worker bubbles)", () => {
  beforeEach(() => {
    useStore.setState({ pendingByWorker: {} });
  });

  it("dropWorkerPending removes exactly the rolled-back bubble", () => {
    useStore.getState().pushWorkerPending("w1", { clientMsgId: "c1", text: "a" });
    useStore.getState().pushWorkerPending("w1", { clientMsgId: "c2", text: "b" });
    useStore.getState().dropWorkerPending("w1", "c1");
    expect(useStore.getState().pendingByWorker["w1"]).toEqual([{ clientMsgId: "c2", text: "b" }]);
  });
});

// setFleet prunes bubbles for workers that can no longer consume the queued message. `background` can:
// the send is accepted and released at the next turn boundary, so pruning it would erase a live "waiting"
// bubble before the daemon's deferred echo arrives.
describe("setFleet pending retention across the worker state graph", () => {
  const row = (id: string, status: string) => ({
    id, label: id, repoPath: "/code/app", status, branch: `rookery/${id}`,
    model: null, permissionMode: "bypassPermissions", ticketKey: null, ticketUrl: null,
  });

  beforeEach(() => {
    useStore.setState({ pendingByWorker: {}, fleet: {}, deletingWorkers: {}, attention: {} } as never);
  });

  it("keeps the pending bubble for a background worker", () => {
    useStore.getState().pushWorkerPending("w1", { clientMsgId: "c1", text: "also check the logs" });
    useStore.getState().setFleet([row("w1", "background")] as never);
    expect(useStore.getState().pendingByWorker["w1"]).toHaveLength(1);
  });

  it("keeps the pending bubble for a running worker", () => {
    useStore.getState().pushWorkerPending("w1", { clientMsgId: "c1", text: "hi" });
    useStore.getState().setFleet([row("w1", "running")] as never);
    expect(useStore.getState().pendingByWorker["w1"]).toHaveLength(1);
  });

  it("still drops ghost bubbles for settled and terminal workers", () => {
    for (const status of ["idle", "stopped", "error"]) {
      useStore.setState({ pendingByWorker: {} } as never);
      useStore.getState().pushWorkerPending("w1", { clientMsgId: "c1", text: "hi" });
      useStore.getState().setFleet([row("w1", status)] as never);
      expect(useStore.getState().pendingByWorker["w1"] ?? []).toHaveLength(0);
    }
  });
});

const imageRef={id:'550e8400-e29b-41d4-a716-446655440000',name:'repeat.png',mediaType:'image/png' as const,byteLength:20,width:1,height:1};
it.each(['master','worker'] as const)('%s keeps consecutive same-ref image-only inputs distinct through live echoes and replay',kind=>{
 useStore.setState({logsBySession:{},workerLogs:{},pendingBySession:{},pendingByWorker:{},connectionEpoch:0});
 const state=useStore.getState();
 const payloads=['one','two'].map(clientMsgId=>({kind:'message' as const,role:'user' as const,content:'',images:[imageRef],clientMsgId}));
 for(const data of payloads) {
  if(kind==='master') {state.pushPending('s',{clientMsgId:data.clientMsgId,text:'',images:[imageRef]});state.applyEvent({type:'master.message',sessionId:'s',role:'user',content:'',images:[imageRef],clientMsgId:data.clientMsgId});}
  else {state.pushWorkerPending('w',{clientMsgId:data.clientMsgId,text:'',images:[imageRef]});state.applyEvent({type:'worker.event',sessionId:'s',workerId:'w',seq:1,data,clientMsgId:data.clientMsgId});}
 }
 const logs=()=>kind==='master'?useStore.getState().logsBySession.s:useStore.getState().workerLogs.w;
 expect(logs()).toHaveLength(2);
 if(kind==='master')state.seedHistory('s',payloads.map((data,seq)=>({seq,type:'master.message',payload:{type:'master.message',sessionId:'s',role:'user',content:'',images:data.images,clientMsgId:data.clientMsgId}})));
 else state.seedWorkerHistory('w',payloads.map((data,seq)=>({seq,type:'message',payload:data})));
 expect(logs()).toHaveLength(2);expect(logs().map(item=>item.kind==='message'?item.clientMsgId:undefined)).toEqual(['one','two']);
 expect(kind==='master'?useStore.getState().pendingBySession.s:useStore.getState().pendingByWorker.w).toEqual([]);
});
it.each(['master','worker'] as const)('%s correlated pre-echo failure removes pending and replays retry refs without local pending',kind=>{
 useStore.setState({logsBySession:{},workerLogs:{},pendingBySession:{},pendingByWorker:{},connectionEpoch:0});
 const state=useStore.getState(),retryInput={text:'',images:[imageRef]};
 if(kind==='master') {state.pushPending('s',{clientMsgId:'failed',text:'',images:[imageRef]});state.applyEvent({type:'error',sessionId:'s',message:'missing',clientMsgId:'failed',retryInput});expect(useStore.getState().pendingBySession.s).toEqual([]);}
 else {state.pushWorkerPending('w',{clientMsgId:'failed',text:'',images:[imageRef]});state.applyEvent({type:'worker.event',sessionId:'s',workerId:'w',seq:1,data:{kind:'error',message:'missing',clientMsgId:'failed',retryInput}});expect(useStore.getState().pendingByWorker.w).toEqual([]);}
 useStore.setState({logsBySession:{},workerLogs:{},pendingBySession:{},pendingByWorker:{}});
 if(kind==='master')state.seedHistory('s',[{seq:0,type:'error',payload:{type:'error',sessionId:'s',message:'missing',clientMsgId:'failed',retryInput}}]);
 else state.seedWorkerHistory('w',[{seq:1,type:'error',payload:{kind:'error',message:'missing',clientMsgId:'failed',retryInput}}]);
 const log=kind==='master'?useStore.getState().logsBySession.s:useStore.getState().workerLogs.w;
 expect(log).toEqual([expect.objectContaining({kind:'failedInput',text:'',images:[imageRef],clientMsgId:'failed'})]);
});
