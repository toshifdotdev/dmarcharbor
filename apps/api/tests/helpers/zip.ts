import { crc32, deflateRawSync } from 'node:zlib';

/**
 * A minimal ZIP writer for tests: what a mail receiver produces when it zips
 * one report. Deflate (method 8) by default, or stored (method 0).
 */
export interface ZipFile {
  name: string;
  content: Buffer | string;
  method?: 0 | 8;
  /** Overrides the checksum written to the directory, to simulate damage. */
  crcOverride?: number;
  /** Sets the "encrypted" flag, without encrypting. */
  encryptedFlag?: boolean;
}

export function buildZip(files: ZipFile[]): Buffer {
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;

  for (const file of files) {
    const raw = Buffer.isBuffer(file.content) ? file.content : Buffer.from(file.content);
    const method = file.method ?? 8;
    const data = method === 8 ? deflateRawSync(raw) : raw;
    const crc = file.crcOverride ?? crc32(raw);
    const name = Buffer.from(file.name);
    const flags = file.encryptedFlag ? 0x1 : 0;

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(flags, 6);
    local.writeUInt16LE(method, 8);
    local.writeUInt32LE(crc >>> 0, 14);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(raw.length, 22);
    local.writeUInt16LE(name.length, 26);
    locals.push(local, name, data);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(flags, 8);
    central.writeUInt16LE(method, 10);
    central.writeUInt32LE(crc >>> 0, 16);
    central.writeUInt32LE(data.length, 20);
    central.writeUInt32LE(raw.length, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt32LE(offset, 42);
    centrals.push(central, name);

    offset += local.length + name.length + data.length;
  }

  const directory = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(files.length, 8);
  end.writeUInt16LE(files.length, 10);
  end.writeUInt32LE(directory.length, 12);
  end.writeUInt32LE(offset, 16);

  return Buffer.concat([...locals, directory, end]);
}
