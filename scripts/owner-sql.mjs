import { email, text } from "../src/domain.mjs";
import { digest } from "../src/security.mjs";

export const quote = (value) => "'" + String(value).replaceAll("'", "''") + "'";

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

export function resetOwnerSQL({ id, mail, previousHash, hash, createdAt }) {
  const normalizedEmail = email(mail, false);
  const target = `id=${quote(id)} AND email=${quote(normalizedEmail)} AND role='owner' AND active=1`;
  const saved = `SELECT id FROM users WHERE ${target} AND password_hash=${quote(hash)}`;
  return `UPDATE users SET password_hash=${quote(hash)},must_change_password=1
WHERE ${target} AND password_hash=${quote(previousHash)};
DELETE FROM sessions WHERE user_id IN (${saved});
DELETE FROM login_limits WHERE key=${quote("email:" + digest(normalizedEmail))} AND EXISTS(${saved});
INSERT INTO audit_log(actor_id,action,entity,entity_id,after_json,created_at)
SELECT NULL,'owner_password_reset','user',id,'{"source":"cloudflare_cli","must_change_password":true}',${quote(createdAt)}
FROM users WHERE ${target} AND password_hash=${quote(hash)};
`;
}
