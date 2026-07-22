// Minimal store-only (no compression) ZIP writer for browser downloads.
// Enough to bundle a handful of small text files into one .zip; no dependency.

function crc32(buf: Uint8Array): number {
  let crc = ~0;
  for (let i = 0; i < buf.length; i++) {
    crc ^= buf[i];
    for (let j = 0; j < 8; j++) crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
  }
  return (~crc) >>> 0;
}

const u16 = (n: number) => [n & 0xff, (n >> 8) & 0xff];
const u32 = (n: number) => [n & 0xff, (n >> 8) & 0xff, (n >> 16) & 0xff, (n >> 24) & 0xff];

export function createZip(files: { name: string; content: string }[]): Blob {
  const enc = new TextEncoder();
  const local: number[] = [];
  const central: number[] = [];
  let offset = 0;

  for (const f of files) {
    const nameBytes = enc.encode(f.name);
    const data = enc.encode(f.content);
    const crc = crc32(data);

    const header = [
      ...u32(0x04034b50), ...u16(20), ...u16(0), ...u16(0), // sig, version, flags, method=store
      ...u16(0), ...u16(0),                                  // mod time, date (fixed)
      ...u32(crc), ...u32(data.length), ...u32(data.length),
      ...u16(nameBytes.length), ...u16(0),                   // name len, extra len
    ];
    local.push(...header, ...nameBytes, ...data);

    central.push(
      ...u32(0x02014b50), ...u16(20), ...u16(20), ...u16(0), ...u16(0),
      ...u16(0), ...u16(0),
      ...u32(crc), ...u32(data.length), ...u32(data.length),
      ...u16(nameBytes.length), ...u16(0), ...u16(0),        // name, extra, comment len
      ...u16(0), ...u16(0), ...u32(0),                       // disk, int/ext attrs
      ...u32(offset),
      ...nameBytes,
    );
    offset += header.length + nameBytes.length + data.length;
  }

  const end = [
    ...u32(0x06054b50), ...u16(0), ...u16(0),
    ...u16(files.length), ...u16(files.length),
    ...u32(central.length), ...u32(offset), ...u16(0),
  ];

  return new Blob([new Uint8Array(local), new Uint8Array(central), new Uint8Array(end)], {
    type: "application/zip",
  });
}
