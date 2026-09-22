import { email, text } from "../src/domain.mjs";

const quote = (value) => "'" + String(value).replaceAll("'", "''") + "'";

export function firstOwnerSQL({ id, mail, name, hash, createdAt }) {
  const values = [
    id,
    email(mail, false),
    text(name, 100, "owner name"),
    hash,
    "owner",
  ];
  return `INSERT INTO users(id,email,name,password_hash,role,must_change_password,created_at)
SELECT ${values.map(quote).join(",")},1,${quote(createdAt)}
WHERE NOT EXISTS(SELECT 1 FROM users WHERE role='owner')
RETURNING id;\n`;
}
