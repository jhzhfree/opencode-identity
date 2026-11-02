import {existsSync} from 'node:fs';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
export const JSONC_DIR = [path.resolve(import.meta.dirname,'../vendor/jsonc-parser'), path.resolve(import.meta.dirname,'../../../vendor/jsonc-parser')].find(dir=>existsSync(path.join(dir,'main.js')));
if(!JSONC_DIR) throw new Error('Packaged JSONC parser missing');
const parser = (await import(pathToFileURL(path.join(JSONC_DIR,'main.js')).href)).default;
export function parseJsonc(text) {
  const errors = [];
  const value = parser.parse(text, errors, {
    allowTrailingComma: true,
    disallowComments: false,
  });
  if (errors.length)
    throw new Error(
      `Invalid JSONC configuration at offset ${errors[0].offset}`,
    );
  return value;
}
export function replaceJsoncFields(text, fields) {
  let result = text;
  for (const [key, value] of Object.entries(fields))
    result = parser.applyEdits(
      result,
      parser.modify(result, [key], value, {
        formattingOptions: { insertSpaces: true, tabSize: 2, eol: "\n" },
      }),
    );
  return result;
}
