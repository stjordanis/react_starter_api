const client = require('./conn')
const { authenticatorPassword, jwtSecret, db } = require('../env')

const sql = `
DROP ROLE IF EXISTS anon, member, authenticator, postgraphile;
CREATE SCHEMA IF NOT EXISTS basic_auth;
CREATE SCHEMA IF NOT EXISTS content;
CREATE EXTENSION IF NOT EXISTS pgcrypto;
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

-- ---------------------------------------------------------------------------
-- Referral system
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS invitations(
    id SERIAL PRIMARY KEY,
    link TEXT,
    senderId TEXT,
    sendermsg TEXT,
    senderName TEXT,
    receiverId TEXT,
    created_at TIMESTAMP DEFAULT current_timestamp,
    updated_at TIMESTAMP
);

-- ---------------------------------------------------------------------------
-- Users
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS basic_auth.users (
    id uuid PRIMARY KEY default uuid_generate_v1mc(),
    email TEXT UNIQUE CHECK (email ~* '^.+@.+\..+$'),
    password TEXT NOT NULL,
    link TEXT,
    role name NOT NULL,
    verified BOOLEAN NOT NULL DEFAULT false,
    first_name TEXT CHECK (char_length(first_name) < 80),
    last_name TEXT CHECK (char_length(last_name) < 80),
    photo TEXT,
    bio TEXT,
    google_id TEXT UNIQUE,
    twitter_id TEXT UNIQUE,
    github_id TEXT UNIQUE,
    facebook_id TEXT UNIQUE,
    linkedin_id TEXT UNIQUE,
    stripe_id TEXT,
    created_at TIMESTAMP DEFAULT current_timestamp,
    updated_at TIMESTAMP DEFAULT current_timestamp
);

CREATE OR REPLACE FUNCTION basic_auth.current_user_id() RETURNS integer AS
$$
    SELECT nullif(current_setting('basic_auth.jwt.claims.user_id', true), '')::integer;
$$ LANGUAGE SQL STABLE;

--CREATE OR REPLACE FUNCTION basic_auth.full_name(user basic_auth.users) RETURNS text AS
--$$
--    SELECT user.first_name || ' ' || user.last_name
--$$ LANGUAGE SQL STABLE;

CREATE OR REPLACE FUNCTION basic_auth.set_updated_at() RETURNS trigger AS
$$
    BEGIN
        new.updated_at := current_timestamp;
        RETURN new;
    END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER user_updated_at BEFORE UPDATE
    ON basic_auth.users
    FOR EACH ROW
    EXECUTE PROCEDURE basic_auth.set_updated_at();

-- ---------------------------------------------------------------------------
-- Posts
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS content.authors (
    id uuid PRIMARY KEY DEFAULT uuid_generate_v1mc(),
    first_name text CHECK (char_length(first_name) < 80),
    last_name text CHECK (char_length(last_name) < 80),
    bio text DEFAULT '',
    created_at TIMESTAMP DEFAULT current_timestamp,
    updated_at TIMESTAMP DEFAULT current_timestamp
);

CREATE TABLE content.topics (
    id SERIAL PRIMARY KEY,
    name text NOT NULL CHECK (char_length(name) < 60)
);

CREATE TABLE content.posts (
    id SERIAL PRIMARY KEY,
    -- author integer NOT NULL REFERENCES content.authors(id),
    headline text NOT NULL CHECK (char_length(headline) < 280),
    body text,
    imageUrl text,
    topic integer NOT NULL REFERENCES content.topics(id),
    created_at TIMESTAMP DEFAULT current_timestamp,
    updated_at TIMESTAMP DEFAULT current_timestamp
);

CREATE OR REPLACE FUNCTION content.post_summary(
    post content.posts,
    length int DEFAULT 50,
    omission text default '…'
) RETURNS text AS
  $$
      SELECT CASE
          WHEN post.body IS null THEN null
          ELSE substr(post.body, 0, length) || omission
  END
  $$ LANGUAGE SQL stable;

--CREATE OR REPLACE FUNCTION content.user_latest_post(user content.authors) RETURNS content.posts AS
--$$
--    SELECT post.*
--    FROM content.posts AS post
--    WHERE post.author_id = author.id
--    ORDER BY created_at DESC
--    LIMIT 1
--$$ LANGUAGE SQL STABLE;

CREATE OR REPLACE FUNCTION content.search_posts(search text) RETURNS SETOF content.posts AS
$$
    SELECT post.*
    FROM content.posts as post
    WHERE post.headline ILIKE ('%' || search || '%') or post.body ILIKE ('%' || search || '%')
$$ LANGUAGE SQL STABLE;

CREATE TRIGGER post_updated_at BEFORE UPDATE
    ON content.posts
    FOR EACH ROW
    EXECUTE PROCEDURE basic_auth.set_updated_at();

-- ---------------------------------------------------------------------------
-- UUID Tokens
-- ---------------------------------------------------------------------------

DROP TYPE IF EXISTS token_type_enum CASCADE;
CREATE TYPE token_type_enum AS enum ('validation', 'reset');
  
CREATE TABLE IF NOT EXISTS basic_auth.tokens (
    token UUID PRIMARY KEY,
    token_type  token_type_enum NOT NULL,
    email TEXT NOT NULL REFERENCES basic_auth.users (email)
    ON DELETE CASCADE ON UPDATE CASCADE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT current_date
);

-- ---------------------------------------------------------------------------
-- JWT Tokens
-- ---------------------------------------------------------------------------

DROP TYPE IF EXISTS basic_auth.jwt_claims CASCADE;
CREATE TYPE basic_auth.jwt_claims AS (role text, email text, exp integer);

-- ---------------------------------------------------------------------------
-- Roles
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION basic_auth.check_role_exists() RETURNS trigger LANGUAGE plpgsql AS
$$
    BEGIN
        IF NOT EXISTS (SELECT 1 FROM pg_roles as r WHERE r.rolname = new.role) THEN
            RAISE foreign_key_violation USING message = 'Unknown database role: ' || new.role;
            RETURN null;
        END IF;
        RETURN new;
    END
$$;

DROP TRIGGER IF EXISTS ensure_user_role_exists on basic_auth.users;

CREATE CONSTRAINT TRIGGER ensure_user_role_exists
    AFTER INSERT OR UPDATE ON basic_auth.users FOR EACH ROW
    EXECUTE PROCEDURE basic_auth.check_role_exists();

    -- ---------------------------------------------------------------------------
-- Hash
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION basic_auth.encrypt_password() RETURNS trigger LANGUAGE plpgsql AS
$$
    BEGIN
        IF tg_op = 'INSERT' OR new.password <> old.password THEN
            new.password = crypt(new.password, gen_salt('bf', 8));
        END IF;
        RETURN new;
    END;
$$;

DROP TRIGGER IF EXISTS encrypt_password ON basic_auth.users;

CREATE TRIGGER encrypt_password
    BEFORE INSERT OR UPDATE ON basic_auth.users
    FOR EACH ROW
    EXECUTE PROCEDURE basic_auth.encrypt_password();
    
CREATE OR REPLACE FUNCTION basic_auth.authenticate_user(email text, password text) RETURNS name LANGUAGE plpgsql AS
$$
    BEGIN
        return (
            SELECT role FROM basic_auth.users
                WHERE users.email = authenticate_user.email
                AND users.password = crypt(authenticate_user.password, users.password)
        );
    END;
$$;

-- ---------------------------------------------------------------------------
-- Signin
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION url_encode(data bytea) RETURNS text LANGUAGE sql AS $$
    SELECT translate(encode(data, 'base64'), E'+/=\n', '-_');
$$;


CREATE OR REPLACE FUNCTION url_decode(data text) RETURNS bytea LANGUAGE SQL AS
$$
    WITH t AS (SELECT translate(data, '-_', '+/') AS trans),
        rem AS (SELECT length(t.trans) % 4 AS remainder FROM t) -- compute padding size
    SELECT decode(
        t.trans ||
        CASE WHEN rem.remainder > 0
            THEN repeat('=', (4 - rem.remainder))
            ELSE '' END, 'base64') FROM t, rem;
$$;

CREATE OR REPLACE FUNCTION algorithm_sign(signables text, secret text, algorithm text)
    RETURNS text LANGUAGE SQL AS
$$
    WITH
        alg AS (
            SELECT CASE
            WHEN algorithm = 'HS256' THEN 'sha256'
            WHEN algorithm = 'HS384' THEN 'sha384'
            WHEN algorithm = 'HS512' THEN 'sha512'
            ELSE '' END AS id)  -- hmac throws error
        SELECT url_encode(hmac(signables, secret, alg.id)) FROM alg;
$$;

CREATE OR REPLACE FUNCTION sign(payload json, secret text, algorithm text DEFAULT 'HS512') RETURNS text LANGUAGE SQL AS
$$
    WITH header AS (
        SELECT url_encode(convert_to('{"alg":"' || algorithm || '","typ":"JWT"}', 'utf8')) AS data
    ),
    payload AS (
        SELECT url_encode(convert_to(payload::text, 'utf8')) AS data
    ),
    signables AS (
        SELECT header.data || '.' || payload.data AS data FROM header, payload
    )
    SELECT
        signables.data || '.' ||
        algorithm_sign(signables.data, secret, algorithm) FROM signables;
$$;

CREATE OR REPLACE FUNCTION verify(token text, secret text, algorithm text DEFAULT 'HS512')
    RETURNS table(header json, payload json, valid boolean) LANGUAGE SQL AS
$$
    SELECT
        convert_from(url_decode(r[1]), 'utf8')::json AS header,
        convert_from(url_decode(r[2]), 'utf8')::json AS payload,
        r[3] = algorithm_sign(r[1] || '.' || r[2], secret, algorithm) AS valid
        FROM regexp_split_to_array(token, '\.') r;
$$;

CREATE OR REPLACE FUNCTION is_json(input_text varchar) RETURNS boolean AS $$
    DECLARE
        maybe_json json;
    BEGIN
        BEGIN
            maybe_json := input_text;
            EXCEPTION WHEN others THEN
                RETURN FALSE;
        END;

        RETURN true;
    END;
$$ LANGUAGE plpgsql IMMUTABLE;

CREATE OR REPLACE FUNCTION login(email text, password text) RETURNS json LANGUAGE plpgsql AS
$$
    DECLARE
        _role name;
        _id uuid;
        _verified boolean;
        _email text;
        _obj json;
        _signed text;
        result json;
    BEGIN
        SELECT basic_auth.authenticate_user(email, password) INTO _role;
        IF _role IS NULL THEN
            RAISE invalid_password USING message = 'Invalid role.';
        END IF;
        _email := email;
        SELECT verified FROM basic_auth.users AS u WHERE u.email = _email LIMIT 1 INTO _verified;
        IF NOT _verified THEN
            RAISE invalid_authorization_specification USING message = 'User is not verified.';
        END IF;
        SELECT id FROM basic_auth.users AS u WHERE u.email = _email LIMIT 1 INTO _id;
        SELECT json_build_object(
            'id', _id,
            'email', _email,
            'expiry', extract(epoch from now())::integer + 60*60
            ) INTO _obj;
        SELECT sign(_obj, '${jwtSecret}') INTO _signed;
        SELECT json_build_object(
            'token', _signed
            )  INTO result;
        RETURN result;
    END;
$$;

-- ---------------------------------------------------------------------------
-- Change email
-- ---------------------------------------------------------------------------

-- This feature is disbled for security reasons.

-- ---------------------------------------------------------------------------
-- Delete user
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION delete_user_account(mail text, password text) RETURNS void LANGUAGE plpgsql AS
$$
    DECLARE
        _role name;
    BEGIN
        SELECT basic_auth.authenticate_user(mail, password) INTO _role;
        IF _role IS NULL THEN
            RAISE invalid_password USING message = 'Invalid role.';
        END IF;
        DELETE FROM basic_auth.users WHERE email = mail;
    END;
$$;

-- ---------------------------------------------------------------------------
-- Update user
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION update_user_info(mail text, password text, firstName text, lastName text, about text) RETURNS json LANGUAGE plpgsql AS
$$
    DECLARE
        _id uuid;
        _role name;
        _signed text;
        result json;
    BEGIN
        SELECT basic_auth.authenticate_user(mail, password) INTO _role;
        IF _role IS NULL THEN
            RAISE invalid_password USING message = 'Invalid role.';
        END IF;
        UPDATE basic_auth.users SET
            first_name = update_user_info.firstName,
            last_name = update_user_info.lastName,
            bio = update_user_info.about
            WHERE email = update_user_info.mail;
        SELECT id FROM basic_auth.users AS u WHERE u.email = mail LIMIT 1 INTO _id;
        SELECT json_build_object(
            'id', _id,
            'email', _email,
            'expiry', extract(epoch from now())::integer + 60*60
            ) INTO _obj;
        SELECT sign(_obj, '${jwtSecret}') INTO _signed;
        SELECT json_build_object(
            'token', _signed
            )  INTO result;
        RETURN result;
    END;
$$;

-- Prevent current_setting('basic_auth.jwt.claims.email') from raising
-- an exception if the setting is not present. Default it to ''.
ALTER DATABASE ${db.database} SET basic_auth.jwt.claims.email TO '';

CREATE OR REPLACE FUNCTION basic_auth.current_email() RETURNS text LANGUAGE plpgsql AS
$$
    BEGIN
        return current_setting('basic_auth.jwt.claims.email');
    END;
$$;

-- ---------------------------------------------------------------------------
-- Password Reset
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION request_password_reset(email text) RETURNS void LANGUAGE plpgsql AS
$$
    DECLARE
        tok uuid;
    BEGIN
        DELETE FROM basic_auth.tokens
            WHERE token_type = 'reset'
            AND tokens.email = request_password_reset.email;
        SELECT gen_random_uuid() into tok;
        INSERT INTO basic_auth.tokens (token, token_type, email)
            VALUES (tok, 'reset', request_password_reset.email);
        PERFORM pg_notify('reset', json_build_object(
            'email', request_password_reset.email,
            'token', tok,
            'token_type', 'reset'
            )::text
        );
    END;
$$;

CREATE OR REPLACE FUNCTION reset_password(email text, token uuid, password text) RETURNS void LANGUAGE plpgsql AS
$$
    DECLARE
        tok uuid;
    BEGIN
        IF EXISTS(
            SELECT 1 FROM basic_auth.tokens
                WHERE tokens.email = reset_password.email
                AND tokens.token = reset_password.token
                AND token_type = 'reset') THEN
            UPDATE basic_auth.users SET password = reset_password.password
                WHERE users.email = reset_password.email;
            DELETE FROM basic_auth.tokens
                WHERE tokens.email = reset_password.email
                AND tokens.token = reset_password.token
                AND token_type = 'reset';
        ELSE
            RAISE invalid_password USING message = 'invalid user or token';
        END IF;
        DELETE FROM basic_auth.tokens
            WHERE token_type = 'reset'
            AND tokens.email = reset_password.email;
        SELECT gen_random_uuid() INTO tok;
        INSERT INTO basic_auth.tokens (token, token_type, email)
            VALUES (tok, 'reset', reset_password.email);
        PERFORM pg_notify('reset', json_build_object(
            'email', reset_password.email,
            'token', tok
            )::text
        );
    END;
$$;

-- ---------------------------------------------------------------------------
-- Validation email
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION basic_auth.send_validation() RETURNS trigger LANGUAGE plpgsql AS
$$
    DECLARE
        tok uuid;
    BEGIN
        SELECT gen_random_uuid() INTO tok;
        INSERT INTO basic_auth.tokens (token, token_type, email)
            VALUES (tok, 'validation', new.email);
        PERFORM pg_notify('validate', json_build_object(
            'email', new.email,
            'token', tok,
            'token_type', 'validation'
            )::text
        );
        RETURN new;
    END;
$$;

CREATE OR REPLACE VIEW users AS
    SELECT actual.role AS role,
        '***'::text AS pass,
        actual.email AS email,
        actual.verified AS verified
    FROM basic_auth.users AS actual,
        (SELECT rolname FROM pg_authid
        WHERE pg_has_role(current_user, oid, 'member')
        ) AS member_of
    WHERE actual.role = member_of.rolname;

DROP TRIGGER IF EXISTS send_validation ON basic_auth.users;

CREATE TRIGGER send_validation
    AFTER INSERT ON basic_auth.users
    FOR EACH ROW
    EXECUTE PROCEDURE basic_auth.send_validation();

-- ---------------------------------------------------------------------------
-- Check role
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION basic_auth.clearance_for_role(u name) RETURNS void AS
$$
    DECLARE
        ok boolean;
        BEGIN
            SELECT EXISTS (
                SELECT rolname
                    FROM pg_authid
                    WHERE pg_has_role(current_user, oid, 'member')
               and rolname = u
            ) INTO ok;
            IF NOT ok THEN
                RAISE invalid_password USING message = 'Current user is not a member of role.' || u;
            END IF;
        END
$$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION update_users() RETURNS trigger LANGUAGE plpgsql AS
$$
    BEGIN
        IF tg_op = 'INSERT' THEN
            PERFORM basic_auth.clearance_for_role(new.role);
            INSERT INTO basic_auth.users (role, password, email, verified)
                VALUES (new.role, new.password, new.email, COALESCE(new.verified, false));
            RETURN new;
        ELSIF tg_op = 'UPDATE' THEN
            PERFORM basic_auth.clearance_for_role(new.role);
            UPDATE basic_auth.users SET
                email = new.email,
                role = new.role,
                password = new.password,
                verified = COALESCE(new.verified, old.verified, false)
                WHERE email = old.email;
            PERFORM new;
        ELSIF tg_op = 'DELETE' THEN
            DELETE FROM basic_auth.users
                WHERE email = old.email;
            RETURN null;
        END IF;
    END
$$;
        
DROP trigger IF EXISTS update_users ON users;

CREATE trigger update_users
    INSTEAD OF INSERT OR UPDATE OR DELETE ON
    users FOR EACH ROW
    EXECUTE PROCEDURE update_users();

-- ---------------------------------------------------------------------------
-- Signup
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION signup(email text, password text) RETURNS void AS
$$
    INSERT INTO basic_auth.users (email, password, role) VALUES (lower(signup.email), signup.password, 'member');
$$ LANGUAGE SQL;

-- ---------------------------------------------------------------------------
-- Validate user
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION validate(tok uuid) RETURNS text LANGUAGE plpgsql AS
$$
    DECLARE
        _verified boolean;
        _email text;
        _val text;
    BEGIN
            SELECT COALESCE((SELECT 1 FROM basic_auth.tokens WHERE token = tok LIMIT 1), 0) INTO _val;
            IF _val = '1' THEN
                SELECT email FROM basic_auth.tokens WHERE token = validate.tok LIMIT 1 INTO _email;
                UPDATE basic_auth.users SET
                    verified = true
                    WHERE email = _email;
                DELETE FROM basic_auth.tokens WHERE token = validate.tok;
            ELSE
                RAISE invalid_authorization_specification USING message = 'No such validation token.';
            END IF;
            RETURN _val;
    END;
$$;

-- ---------------------------------------------------------------------------
-- Postgres Schema Reload
-- ---------------------------------------------------------------------------

-- Also run pg_listen <db-uri> ddl_command_end "killall -HUP postgres"
CREATE OR REPLACE FUNCTION public.notify_ddl()
    RETURNS event_trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
    NOTIFY ddl_command_end;
END;
$$;

CREATE EVENT TRIGGER ddl_postgres ON ddl_command_end EXECUTE PROCEDURE public.notify_ddl();

CREATE ROLE anon;
CREATE ROLE member;
CREATE ROLE authenticator NOINHERIT LOGIN PASSWORD '${authenticatorPassword}';
GRANT anon TO authenticator;
GRANT anon TO member;
GRANT USAGE ON SCHEMA public, basic_auth TO anon;
GRANT SELECT ON TABLE pg_authid, basic_auth.users TO anon;
GRANT EXECUTE ON FUNCTION login(text, text) TO anon;
GRANT EXECUTE ON FUNCTION
    signup(text, text),
    validate(uuid),
    delete_user_account(text, text),
    update_user_info(text, text, text, text, text)
    TO anon;
`

client.query(sql, (err, res) => {
  console.log(err ? err.message : res)
  client.end()
})
