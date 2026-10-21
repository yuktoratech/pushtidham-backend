import {test} from "node:test";
import assert from "node:assert/strict";
import {readFile} from "node:fs/promises";
import {resolve} from "node:path";
import {validateTrustedSvg} from "../src/utils/trusted-svg.js";

test("repository festival illustrations pass the static SVG allowlist", async () => {
  for (const name of ["annakut", "hindola", "holi", "janmashtami", "mahaprabhuji", "nand-mahotsav", "pavitra-ekadashi", "vasant-panchami"]) {
    const source = await readFile(resolve("../pushtidham-frontend/public/images/festivals", `${name}.svg`), "utf8");
    assert.deepEqual(validateTrustedSvg(source), {valid: true}, name);
  }
});

test("active SVG features and external references are rejected", () => {
  for (const source of [
    '<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>',
    '<svg xmlns="http://www.w3.org/2000/svg"><path onload="alert(1)"/></svg>',
    '<svg xmlns="http://www.w3.org/2000/svg"><image href="https://example.test/a.png"/></svg>',
    '<svg xmlns="http://www.w3.org/2000/svg"><foreignObject/></svg>',
    '<!DOCTYPE svg [<!ENTITY x SYSTEM "file:///etc/passwd">]><svg>&x;</svg>',
  ]) assert.equal(validateTrustedSvg(source).valid, false);
});
