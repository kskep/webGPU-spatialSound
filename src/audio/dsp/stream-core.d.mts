export interface PreparedResponse {
  blockSize: number;
  length: number;
  partitions: number;
  bins: number;
  lr: Float32Array;
  li: Float32Array;
  rr: Float32Array;
  ri: Float32Array;
  lateGains?: number[];
  modalWeights?: number[];
}
export function prepareResponse(
  left: Float32Array,
  right: Float32Array,
  blockSize?: number,
): PreparedResponse;
export function fft(real: Float64Array, imag: Float64Array, inverse?: boolean): void;
