export function createStaticI420Frame(
  width: number,
  height: number,
  luma: 16 | 32 = 16
): { width: number; height: number; data: Buffer } {
  if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) {
    throw new Error("invalid frame dimensions");
  }

  const w = Math.floor(width);
  const h = Math.floor(height);

  // I420 = Y plane (w*h) + U plane (w*h/4) + V plane (w*h/4)
  const ySize = w * h;
  const uvSize = (w * h) / 4;
  const total = ySize + uvSize + uvSize;

  // For production resilience: allow odd sizes (best effort), but still allocate full buffer.
  const buf = Buffer.alloc(Math.floor(total));

  // Neutral dark-ish frame.
  buf.fill(luma, 0, ySize);
  buf.fill(128, ySize, ySize + uvSize);
  buf.fill(128, ySize + uvSize, ySize + uvSize + uvSize);

  return { width: w, height: h, data: buf };
}

