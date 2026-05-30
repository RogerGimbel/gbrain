import { loadEvalCaptureFile, type EvalCaptureFile } from '../eval-capture.ts';

export type BaselineFile = EvalCaptureFile;

export function loadBaselineFile(path: string): BaselineFile {
  return loadEvalCaptureFile(path);
}
