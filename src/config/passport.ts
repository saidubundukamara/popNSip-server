import passport from 'passport';
import { Strategy as LocalStrategy } from 'passport-local';

import { loadActiveUser, validateCredentials } from '@/services/auth_service';

/**
 * passport-local over email + password.
 *
 * The important part is `deserializeUser`: it re-reads the account on every
 * request and refuses an inactive one, which is what makes deactivating a
 * signed-in user revoke their session rather than merely stop new logins
 * (FR-AUTH-5).
 */
export function configurePassport(): void {
  passport.use(
    new LocalStrategy({ usernameField: 'email', passwordField: 'password' }, (email, password, done) => {
      validateCredentials(email, password)
        .then((user) => done(null, user ?? false))
        .catch((error: unknown) => done(error));
    }),
  );

  passport.serializeUser<string>((user, done) => {
    done(null, user.id);
  });

  passport.deserializeUser<string>((id, done) => {
    loadActiveUser(id)
      .then((user) => done(null, user ?? false))
      .catch((error: unknown) => done(error));
  });
}

export { passport };
