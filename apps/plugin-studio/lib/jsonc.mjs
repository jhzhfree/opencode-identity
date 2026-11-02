import parser from "../../../vendor/jsonc-parser/main.js";
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
