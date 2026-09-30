const assert = require("node:assert/strict");
const test = require("node:test");
const { serverOrigin, isSameOrigin } = require("../policy.cjs");

test("release builds accept only HTTPS origins without credentials or paths", () => {
  assert.equal(serverOrigin("https://studio.example.com/"), "https://studio.example.com");
  for (const url of ["http://studio.example.com", "http://localhost:3000", "https://user:pass@studio.example.com", "https://studio.example.com/path", "https://studio.example.com/?token=x", "file:///etc/passwd", "javascript:alert(1)"]) {
    assert.throws(() => serverOrigin(url), url);
  }
});
test("only development builds allow HTTP on loopback", () => {
  assert.equal(serverOrigin("http://127.0.0.1:3019", false), "http://127.0.0.1:3019");
  assert.throws(() => serverOrigin("http://192.168.1.10", false));
});
test("navigation is constrained to the configured origin", () => {
  const origin = "https://studio.example.com";
  assert.equal(isSameOrigin(`${origin}/login`, origin), true);
  for (const url of ["https://studio.example.com.attacker.test", "https://studio.example.com@attacker.test", "http://studio.example.com", "file:///tmp/payload", "javascript:alert(1)"]) assert.equal(isSameOrigin(url, origin), false);
});
