-- One-time code sign-in (010) is removed: the phone signs in with Google on
-- the https dev tunnel (or the real domain), so the LAN-only code path has no
-- use. Drop its table with it rather than leave a table nothing reads.
drop table if exists device_codes;
