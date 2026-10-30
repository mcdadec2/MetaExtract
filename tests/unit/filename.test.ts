import { describe, expect, it } from 'vitest';
import {
  DEFAULT_FILENAME_TEMPLATE,
  extensionFor,
  renderFilename,
  sanitizeField,
  sidecarFilename,
} from '../../src/lib/filename';

const date = new Date(2026, 9, 30, 9, 5, 7);
const vars = { site: 'example.com', title: 'My clip', date, id: 'abc123', ext: 'mp4' };

describe('renderFilename', () => {
  it('renders the default template', () => {
    expect(renderFilename(DEFAULT_FILENAME_TEMPLATE, vars)).toBe(
      'MetaExtract/example.com_2026-10-30_My clip.mp4',
    );
  });

  it('supports {time} and {id}, and leaves unknown variables alone', () => {
    expect(renderFilename('{date}_{time}_{id}_{nope}.{ext}', vars)).toBe(
      '2026-10-30_09-05-07_abc123_{nope}.mp4',
    );
  });

  it('never lets a title add folders or escape the downloads folder', () => {
    const result = renderFilename('{title}.{ext}', { ...vars, title: '../../etc/passwd' });
    expect(result).not.toContain('/');
    expect(result).not.toContain('..');
  });

  it('drops dot-only and empty template segments', () => {
    expect(renderFilename('../a//./b/{title}.{ext}', vars)).toBe('a/b/My clip.mp4');
  });

  it('falls back when the title is empty or unusable', () => {
    expect(renderFilename('{title}.{ext}', { ...vars, title: '  ' })).toBe('video.mp4');
  });

  it('avoids Windows reserved names', () => {
    expect(renderFilename('{title}.{ext}', { ...vars, title: 'CON' })).toBe('_CON.mp4');
  });
});

describe('sanitizeField', () => {
  it('replaces characters that are invalid in filenames and caps length', () => {
    expect(sanitizeField('a<b>c:"d"|e?f*g\\h/i\n')).toBe('a_b_c_d_e_f_g_h_i_');
    expect(sanitizeField('x'.repeat(500))).toHaveLength(80);
  });
});

describe('extensionFor', () => {
  it('uses the URL extension, then the MIME type, then mp4', () => {
    expect(extensionFor('https://a.test/v.webm')).toBe('webm');
    expect(extensionFor('https://a.test/v', 'video/webm')).toBe('webm');
    expect(extensionFor('https://a.test/v.php')).toBe('mp4');
  });
});

describe('sidecarFilename', () => {
  it('swaps the extension for .json', () => {
    expect(sidecarFilename('MetaExtract/a.b_c.mp4')).toBe('MetaExtract/a.b_c.json');
    expect(sidecarFilename('dir.x/noext')).toBe('dir.x/noext.json');
  });
});
