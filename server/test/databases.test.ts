import { describe, expect, it } from "bun:test";

import {
  clipCell,
  databaseId,
  DB_CELL_MAX,
  discoverDatabases,
  isEnvFile,
  looksLikeSelect,
  parseDotenv,
  parsePostgresUrl,
  quoteIdent,
  sortEnvFiles,
  trimSql,
  typeName,
  withDatabase,
} from "../../shared/databases";

describe("isEnvFile", () => {
  it("takes the dotenv family", () => {
    for (const name of [".env", ".env.local", ".env.prod", ".env.production.local", ".env.staging"]) {
      expect(isEnvFile(name)).toBe(true);
    }
  });

  it("refuses placeholders and leftovers, which parse as perfectly good URLs to nowhere", () => {
    for (const name of [".env.example", ".env.sample", ".env.template", ".env.local.bak-20261006-2344", ".env.backup", ".env.old"]) {
      expect(isEnvFile(name)).toBe(false);
    }
  });

  it("refuses anything that is not an env file", () => {
    for (const name of ["env", ".envrc", ".environment", "config.env", ".env/", ".env.local/x"]) {
      expect(isEnvFile(name)).toBe(false);
    }
  });
});

describe("parseDotenv", () => {
  it("reads bare, quoted and exported assignments", () => {
    const vars = parseDotenv([
      "# a comment",
      "A=one",
      "export B=two",
      'C="three four"',
      "D='five # not a comment'",
      "E=six # a comment",
      "F = seven",
      "",
      "G=`eight`",
    ].join("\n"));
    expect(vars.get("A")).toBe("one");
    expect(vars.get("B")).toBe("two");
    expect(vars.get("C")).toBe("three four");
    expect(vars.get("D")).toBe("five # not a comment");
    expect(vars.get("E")).toBe("six");
    expect(vars.get("F")).toBe("seven");
    expect(vars.get("G")).toBe("eight");
  });

  it("expands \\n in double quotes and not in single", () => {
    const vars = parseDotenv('A="x\\ny"\nB=\'x\\ny\'');
    expect(vars.get("A")).toBe("x\ny");
    expect(vars.get("B")).toBe("x\\ny");
  });

  it("lets a quoted value run over several lines, and keeps reading after it", () => {
    const vars = parseDotenv('KEY="-----BEGIN\nabc\n-----END"\nAFTER=yes');
    expect(vars.get("KEY")).toBe("-----BEGIN\nabc\n-----END");
    expect(vars.get("AFTER")).toBe("yes");
  });

  it("lets the last assignment win, as dotenv does", () => {
    expect(parseDotenv("A=1\nA=2").get("A")).toBe("2");
  });

  it("reads a URL with a percent-encoded password untouched", () => {
    const vars = parseDotenv("DATABASE_URL=postgresql://u:p%40ss@h:5432/db?sslmode=require");
    expect(vars.get("DATABASE_URL")).toBe("postgresql://u:p%40ss@h:5432/db?sslmode=require");
  });

  it("copes with CRLF", () => {
    expect(parseDotenv("A=1\r\nB=2\r\n").get("B")).toBe("2");
  });
});

describe("parsePostgresUrl", () => {
  it("reads both spellings of the scheme", () => {
    expect(parsePostgresUrl("postgres://u:p@h:5433/db")).toEqual({ host: "h", port: 5433, database: "db", user: "u", ssl: false });
    expect(parsePostgresUrl("postgresql://u:p@h/db")).toEqual({ host: "h", port: 5432, database: "db", user: "u", ssl: false });
  });

  it("refuses anything else", () => {
    expect(parsePostgresUrl("mysql://u:p@h/db")).toBeNull();
    expect(parsePostgresUrl("https://example.com")).toBeNull();
    expect(parsePostgresUrl("not a url")).toBeNull();
    expect(parsePostgresUrl("")).toBeNull();
  });

  it("reads sslmode, and only the modes that mean TLS", () => {
    expect(parsePostgresUrl("postgres://u:p@h/db?sslmode=verify-full")?.ssl).toBe(true);
    expect(parsePostgresUrl("postgres://u:p@h/db?sslmode=require")?.ssl).toBe(true);
    expect(parsePostgresUrl("postgres://u:p@h/db?sslmode=disable")?.ssl).toBe(false);
    expect(parsePostgresUrl("postgres://u:p@h/db?sslmode=prefer")?.ssl).toBe(false);
    expect(parsePostgresUrl("postgres://u:p@h/db?ssl=true")?.ssl).toBe(true);
  });

  it("names the database after the user when the path is empty, as libpq does", () => {
    expect(parsePostgresUrl("postgres://alice:p@h")?.database).toBe("alice");
    expect(parsePostgresUrl("postgres://alice:p@h/")?.database).toBe("alice");
  });

  it("reads a socket URL's host from the query", () => {
    const t = parsePostgresUrl("postgres:///db?host=/var/run/postgresql");
    expect(t?.host).toBe("/var/run/postgresql");
    expect(t?.database).toBe("db");
  });

  it("decodes the user and database, and never returns the password", () => {
    const t = parsePostgresUrl("postgres://my%40user:s3cret@h/my%20db");
    expect(t).toEqual({ host: "h", port: 5432, database: "my db", user: "my@user", ssl: false });
    expect(JSON.stringify(t)).not.toContain("s3cret");
  });

  it("reads a host with no dots, which a container network hands out", () => {
    expect(parsePostgresUrl("postgresql://u:p@databases-pg18-k1mkqm:5432/jajotopa_prod")?.host).toBe("databases-pg18-k1mkqm");
  });

  it("ignores the parameters Prisma adds", () => {
    expect(parsePostgresUrl("postgres://u:p@h/db?schema=public&pgbouncer=true&connection_limit=1")?.database).toBe("db");
  });
});

describe("withDatabase", () => {
  it("changes only the path", () => {
    expect(withDatabase("postgresql://u:p%40ss@h:5432/one?sslmode=require", "two")).toBe(
      "postgresql://u:p%40ss@h:5432/two?sslmode=require",
    );
  });

  it("quotes a name that needs it", () => {
    expect(withDatabase("postgres://u:p@h/one", "my db")).toBe("postgres://u:p@h/my%20db");
  });
});

describe("quoteIdent", () => {
  it("doubles a quote, which is the only way out of one", () => {
    expect(quoteIdent("plain")).toBe('"plain"');
    expect(quoteIdent('a"b')).toBe('"a""b"');
    expect(quoteIdent("x; drop table y")).toBe('"x; drop table y"');
  });
});

describe("discoverDatabases", () => {
  const prod = "postgresql://app:pw@db.example.com:5432/app_prod?sslmode=verify-full";
  const local = "postgres://postgres:postgres@localhost:5432/app";

  it("finds one entry per place, labelled by the file", () => {
    const found = discoverDatabases([
      { file: ".env", text: `DATABASE_URL=${local}\nOTHER=1` },
      { file: ".env.prod", text: `DATABASE_URL="${prod}"` },
    ]);
    expect(found.map((d) => [d.files, d.key, d.host, d.database])).toEqual([
      [[".env"], "DATABASE_URL", "localhost", "app"],
      [[".env.prod"], "DATABASE_URL", "db.example.com", "app_prod"],
    ]);
  });

  it("lets the direct URL stand for the pooled one when both name the same database", () => {
    const found = discoverDatabases([
      {
        file: ".env.prod",
        text: [
          "DATABASE_URL=postgresql://app:pw@databases-pg18-k1mkqm:5432/app_prod",
          `DATABASE_URL_DIRECT=${prod}`,
        ].join("\n"),
      },
    ]);
    expect(found).toHaveLength(1);
    expect(found[0]?.key).toBe("DATABASE_URL_DIRECT");
    expect(found[0]?.host).toBe("db.example.com");
  });

  it("keeps two keys that name two databases", () => {
    const found = discoverDatabases([
      { file: ".env", text: `DATABASE_URL=${local}\nSHADOW_DATABASE_URL=postgres://postgres:postgres@localhost:5432/app_shadow` },
    ]);
    expect(found.map((d) => d.database)).toEqual(["app", "app_shadow"]);
  });

  it("folds two files that point at the same place into one entry that says both", () => {
    const found = discoverDatabases([
      { file: ".env.local", text: `DATABASE_URL=${prod}` },
      { file: ".env.prod", text: `DATABASE_URL=${prod}\nDATABASE_URL_DIRECT=${prod}` },
    ]);
    expect(found).toHaveLength(1);
    expect(found[0]?.files).toEqual([".env.local", ".env.prod"]);
  });

  it("ignores variables that are not Postgres URLs", () => {
    const found = discoverDatabases([
      { file: ".env", text: "REDIS_URL=redis://localhost:6379\nNEXT_PUBLIC_URL=https://x.y\nDATABASE_URL=" },
    ]);
    expect(found).toEqual([]);
  });

  it("never carries the password", () => {
    const found = discoverDatabases([{ file: ".env", text: `DATABASE_URL=${prod}` }]);
    expect(JSON.stringify(found)).not.toContain("pw");
  });
});

describe("sortEnvFiles", () => {
  it("puts .env first and the rest in order", () => {
    expect(sortEnvFiles([".env.prod", ".env.local", ".env"])).toEqual([".env", ".env.local", ".env.prod"]);
  });
});

describe("databaseId", () => {
  const t = { host: "h", port: 5432, database: "d", user: "u", ssl: false };

  it("is stable, and different for a different root or target", () => {
    expect(databaseId("/a", t)).toBe(databaseId("/a", t));
    expect(databaseId("/a", t)).not.toBe(databaseId("/b", t));
    expect(databaseId("/a", t)).not.toBe(databaseId("/a", { ...t, database: "e" }));
    expect(databaseId("/a", t)).toMatch(/^[0-9a-f]{16}$/);
  });

  it("does not depend on ssl, which is how the connection is made rather than where it goes", () => {
    expect(databaseId("/a", t)).toBe(databaseId("/a", { ...t, ssl: true }));
  });
});

describe("typeName", () => {
  it("names the common ones and nothing for the rest", () => {
    expect(typeName(23)).toBe("int4");
    expect(typeName(3802)).toBe("jsonb");
    expect(typeName(999_999)).toBe("");
  });
});

describe("clipCell", () => {
  it("keeps null as null and short cells whole", () => {
    expect(clipCell(null)).toBeNull();
    expect(clipCell("")).toBe("");
    expect(clipCell("abc")).toBe("abc");
  });

  it("cuts a long cell with a marker", () => {
    const cut = clipCell("x".repeat(DB_CELL_MAX + 10))!;
    expect(cut.length).toBe(DB_CELL_MAX + 1);
    expect(cut.endsWith("…")).toBe(true);
  });
});

describe("looksLikeSelect", () => {
  it("takes a read, in any case and behind a comment", () => {
    expect(looksLikeSelect("SELECT 1")).toBe(true);
    expect(looksLikeSelect("  select * from t;")).toBe(true);
    expect(looksLikeSelect("-- the users\nwith u as (select 1) select * from u")).toBe(true);
    expect(looksLikeSelect("/* x */ TABLE users")).toBe(true);
  });

  it("refuses a write, and a second statement", () => {
    expect(looksLikeSelect("update t set x = 1")).toBe(false);
    expect(looksLikeSelect("select 1; select 2")).toBe(false);
    expect(looksLikeSelect("insert into t values (1)")).toBe(false);
    expect(looksLikeSelect("")).toBe(false);
  });
});

describe("trimSql", () => {
  it("drops trailing semicolons and whitespace", () => {
    expect(trimSql("select 1;\n")).toBe("select 1");
    expect(trimSql("select 1;;  ")).toBe("select 1");
    expect(trimSql("select ';'")).toBe("select ';'");
  });
});
