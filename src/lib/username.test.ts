import { describe, expect, it } from "vitest";
import { accountName, loginEmail, usernameKey } from "./username";

describe("username", () => {
  it("folds accents and case, rejects bad names", () => {
    expect(usernameKey(" Jéjé ")).toBe("jeje");
    expect(usernameKey("Momo Lapointe")).toBe("momo-lapointe");
    expect(usernameKey("ab")).toBeNull();
    expect(usernameKey("moi!")).toBeNull();
  });
  it("turns a username into its login address and back", () => {
    const email = loginEmail("Jéjé")!;
    expect(email).toBe("jeje@utilisateurs.momo-et-jeje.app");
    expect(accountName(email)).toBe("jeje");
  });
  it("keeps a real email as is", () => {
    expect(loginEmail("a@b.ca")).toBe("a@b.ca");
    expect(accountName("a@b.ca")).toBe("a@b.ca");
  });
});
