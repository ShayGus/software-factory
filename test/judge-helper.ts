import type { InstructionJudgeConfig, InstructionJudgeVerdict } from '../src/index.js';
export const fakeJudge: InstructionJudgeConfig = {
  executable: process.execPath, args: [new URL('../../fixtures/fake-instruction-judge.mjs', import.meta.url).pathname],
};
export const fakeVerdict = (verdict: InstructionJudgeVerdict): InstructionJudgeConfig => ({ ...fakeJudge,
  args: [...fakeJudge.args!, '--result', JSON.stringify(verdict)],
});
