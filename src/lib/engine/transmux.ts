import { Transmuxer } from 'mux.js/lib/mp4/transmuxer';
import { concat } from '../mp4/box';

/**
 * Converts consecutive MPEG-TS (or packed AAC) segments into fragmented MP4.
 * The first call returns the init segment too; timestamps stay continuous
 * across calls because one mux.js transmuxer sees every segment.
 */
export class TsToMp4 {
  private readonly transmuxer = new Transmuxer({ remux: true });
  private output: Uint8Array[] = [];
  private sentInit = false;

  constructor() {
    this.transmuxer.on('data', (segment) => {
      if (!this.sentInit) {
        this.output.push(segment.initSegment);
        this.sentInit = true;
      }
      this.output.push(segment.data);
    });
  }

  convert(segment: Uint8Array): Uint8Array {
    this.transmuxer.push(segment);
    this.transmuxer.flush();
    return concat(this.output.splice(0));
  }
}

export async function decryptAes128(
  data: Uint8Array<ArrayBuffer>,
  key: Uint8Array,
  iv: Uint8Array,
): Promise<Uint8Array<ArrayBuffer>> {
  if (key.length !== 16) throw new Error('The stream’s AES-128 key is not 16 bytes.');
  const cryptoKey = await crypto.subtle.importKey('raw', new Uint8Array(key), 'AES-CBC', false, ['decrypt']);
  // WebCrypto also strips the PKCS#7 padding HLS uses.
  return new Uint8Array(await crypto.subtle.decrypt({ name: 'AES-CBC', iv: new Uint8Array(iv) }, cryptoKey, data));
}
