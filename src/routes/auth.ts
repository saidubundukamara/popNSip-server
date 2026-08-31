import { Router } from 'express';
import type { RequestHandler } from 'express';
import { z } from 'zod';

import { SESSION_COOKIE_NAME } from '@/config/constants';
import { passport } from '@/config/passport';
import { UnauthorizedError } from '@/lib/errors';
import { requireAuth } from '@/middleware/auth';
import { loginEmailLimiter, loginIpLimiter } from '@/middleware/rate_limit';
import { audit } from '@/services/audit_service';
import type { SessionUser } from '@/services/auth_service';
import { changeOwnPassword, recordLogin } from '@/services/auth_service';

export const authRouter: Router = Router();

const loginSchema = z.object({
  email: z.email().transform((value) => value.toLowerCase()),
  password: z.string().min(1, 'Password is required.'),
});

const changePasswordSchema = z.object({
  currentPassword: z.string().min(1),
  newPassword: z.string().min(12, 'Use at least 12 characters.'),
});

/**
 * Parsed before the strategy runs, so a malformed body is a 422 rather than a
 * 401 — and so the per-email limiter downstream has a normalised email to key
 * on.
 */
const parseLogin: RequestHandler = (req, _res, next) => {
  const parsed = loginSchema.safeParse(req.body);
  if (!parsed.success) {
    next(parsed.error);
    return;
  }
  req.body = parsed.data;
  next();
};

authRouter.post('/api/auth/login', loginIpLimiter, parseLogin, loginEmailLimiter, (req, res, next) => {
  passport.authenticate('local', (error: unknown, user: SessionUser | false) => {
    if (error) {
      next(error);
      return;
    }
    if (!user) {
      // One message for a wrong email, a wrong password, and a deactivated
      // account. Which of the three it was is not the client's business.
      next(new UnauthorizedError('Email or password is incorrect.'));
      return;
    }

    req.logIn(user, (loginError) => {
      if (loginError) {
        next(loginError);
        return;
      }

      void recordLogin(user.id);
      void audit({
        actor: { id: user.id, role: user.role },
        action: 'auth.login',
        targetType: 'StaffUser',
        targetId: user.id,
        requestId: req.id,
      });

      res.json({ user });
    });
  })(req, res, next);
});

authRouter.post('/api/auth/logout', requireAuth, (req, res, next) => {
  const user = req.user;

  req.logout((logoutError) => {
    if (logoutError) {
      next(logoutError);
      return;
    }

    req.session.destroy((destroyError) => {
      if (destroyError) {
        next(destroyError);
        return;
      }

      res.clearCookie(SESSION_COOKIE_NAME);
      if (user) {
        void audit({
          actor: { id: user.id, role: user.role },
          action: 'auth.logout',
          targetType: 'StaffUser',
          targetId: user.id,
          requestId: req.id,
        });
      }
      res.status(204).end();
    });
  });
});

authRouter.get('/api/auth/me', requireAuth, (req, res) => {
  res.json({ user: req.user });
});

authRouter.post('/api/auth/password', requireAuth, (req, res, next) => {
  const parsed = changePasswordSchema.safeParse(req.body);
  if (!parsed.success) {
    next(parsed.error);
    return;
  }

  const user = req.user;
  if (!user) {
    next(new UnauthorizedError());
    return;
  }

  changeOwnPassword(user.id, parsed.data.currentPassword, parsed.data.newPassword)
    .then(async () => {
      await audit({
        actor: { id: user.id, role: user.role },
        action: 'auth.password_changed',
        targetType: 'StaffUser',
        targetId: user.id,
        requestId: req.id,
      });
      res.status(204).end();
    })
    .catch(next);
});
