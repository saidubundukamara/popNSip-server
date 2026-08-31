import { Router } from 'express';

import { NotFoundError } from '@/lib/errors';
import { publicApiLimiter } from '@/middleware/rate_limit';
import { repositories } from '@/repositories';
import { getPublicItem, getPublicMenu } from '@/services/menu_service';

/**
 * The storefront's read surface. No auth, rate-limited, and cacheable for a
 * short window — a menu that is 30 seconds stale is fine; a menu that costs a
 * query per visitor on a 3G connection is not.
 */
export const publicMenuRouter: Router = Router();

publicMenuRouter.use('/api/menu', publicApiLimiter);

publicMenuRouter.get('/api/menu', (req, res, next) => {
  repositories.branches
    .findFirst()
    .then(async (branch) => {
      if (!branch) throw new NotFoundError('No branch is configured.');

      const categories = await getPublicMenu(branch.id);
      res.set('Cache-Control', 'public, max-age=30, stale-while-revalidate=120');
      res.json({
        branch: {
          id: branch.id,
          name: branch.name,
          currency: branch.currency,
          deliveryEnabled: branch.deliveryEnabled,
          pickupEnabled: branch.pickupEnabled,
          dineInEnabled: branch.dineInEnabled,
        },
        categories,
      });
    })
    .catch(next);
});

publicMenuRouter.get('/api/menu/items/:id', (req, res, next) => {
  const id = req.params.id;
  if (!id) {
    next(new NotFoundError('Item not found.'));
    return;
  }

  getPublicItem(id)
    .then((item) => {
      res.set('Cache-Control', 'public, max-age=30, stale-while-revalidate=120');
      res.json({ item });
    })
    .catch(next);
});
