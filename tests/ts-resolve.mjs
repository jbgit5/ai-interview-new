// Lets the regression tests load app source that imports sibling modules without an extension
// (`import { x } from "../live/turnTaking"`), the way Next.js/TypeScript expect. Node's own ESM
// resolver needs the extension, so on a failed relative import we retry with ".ts".
// Used via:  node --import ./tests/ts-resolve.mjs --experimental-strip-types tests/<file>.mjs
import { register } from "node:module";

const hook = `
export async function resolve(specifier, context, next) {
  try {
    return await next(specifier, context);
  } catch (err) {
    if (specifier.startsWith(".") && !/\\.[cm]?[jt]sx?$/.test(specifier)) {
      return next(specifier + ".ts", context);
    }
    throw err;
  }
}`;

register("data:text/javascript," + encodeURIComponent(hook));
