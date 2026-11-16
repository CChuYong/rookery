import type { Catalog } from "../../types.js";
export default {
  "branchDiff.empty": "기준 브랜치 이후 변경 사항이 없어요",
  "branchDiff.loadFailed": "브랜치 변경 사항을 불러오지 못했어요",
  "branchDiff.files": "변경된 파일 {count}개",
  "branchDiff.vsForkPoint": "분기 시점 대비 변경",
  "branchDiff.truncated": "변경 사항이 너무 커서 앞부분(512 KB)만 보여요",
  "branchDiff.binary": "바이너리 파일이라 내용 비교를 보여 줄 수 없어요",
  "branchDiff.renamedOnly": "이름만 바뀌었어요: {from} → {to}",
  "branchDiff.modeOnly": "파일 모드만 바뀌었어요 ({mode})",
  "branchDiff.noTextChange": "내용 변경이 없어요",
} satisfies Catalog;
