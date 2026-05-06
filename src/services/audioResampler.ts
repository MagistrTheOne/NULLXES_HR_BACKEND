export function resamplePcm16Linear(
  input: Int16Array,
  inputRateHz: number,
  outputRateHz: number
): Int16Array {
  if (inputRateHz === outputRateHz) {
    return input;
  }
  if (input.length === 0) {
    return new Int16Array(0);
  }

  const ratio = outputRateHz / inputRateHz;
  const outLength = Math.max(1, Math.floor(input.length * ratio));
  const out = new Int16Array(outLength);

  for (let i = 0; i < outLength; i += 1) {
    const srcPos = i / ratio;
    const i0 = Math.floor(srcPos);
    const i1 = Math.min(i0 + 1, input.length - 1);
    const t = srcPos - i0;
    const s0 = input[i0] ?? 0;
    const s1 = input[i1] ?? 0;
    const v = s0 + (s1 - s0) * t;
    out[i] = Math.max(-32768, Math.min(32767, Math.round(v)));
  }
  return out;
}

