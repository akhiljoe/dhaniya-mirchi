// Households are linked by verified email. The same person can end up with a
// second account (Cognito issued a different user for the same Google login);
// on sign-in, an account with no household joins the households of any other
// account with the same verified email, with the same role — instead of
// starting an empty household. Emails reach `users` only when verified
// (oidc.ts), so an address someone merely typed can never link in. Accounts
// that already have a household are left alone.
import type { Db } from '../db.js';
import { errorFields, type Logger } from '../logger.js';

export async function linkHouseholdsByEmail(db: Db, logger: Logger, userId: string): Promise<number> {
  try {
    const { rowCount } = await db.query(
      `insert into household_members (household_id, user_id, role)
       select m.household_id, me.id, m.role
         from users me
         join users other on lower(other.email) = lower(me.email) and other.id <> me.id
         join household_members m on m.user_id = other.id
        where me.id = $1 and me.email is not null
          and not exists (select 1 from household_members x where x.user_id = me.id)
       on conflict do nothing`,
      [userId],
    );
    if (rowCount) logger.info('account joined its household by verified email', { households: rowCount });
    return rowCount ?? 0;
  } catch (err) {
    // Not linking is safe: the user just starts without a household.
    logger.error('could not link households by email', errorFields(err));
    return 0;
  }
}
