export function minimalJpeg(scanData: Buffer = Buffer.from([0x01])): Buffer {
  const entropyData = scanData.length > 0 ? scanData : Buffer.from([0x01]);

  return Buffer.concat([
    Buffer.from([0xff, 0xd8]),
    Buffer.from([
      0xff,
      0xc0,
      0x00,
      0x0b,
      0x08,
      0x00,
      0x01,
      0x00,
      0x01,
      0x01,
      0x01,
      0x11,
      0x00,
    ]),
    Buffer.from([
      0xff,
      0xda,
      0x00,
      0x08,
      0x01,
      0x01,
      0x00,
      0x00,
      0x3f,
      0x00,
    ]),
    entropyData,
    Buffer.from([0xff, 0xd9]),
  ]);
}
