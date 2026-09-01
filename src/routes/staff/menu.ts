import { Router } from 'express';
import type { RequestHandler } from 'express';
import multer from 'multer';
import { z } from 'zod';

import { StaffRole } from '@/generated/prisma/enums';
import { BadRequestError, NotFoundError } from '@/lib/errors';
import { requireRole } from '@/middleware/auth';
import { audit } from '@/services/audit_service';
import { MAX_IMAGE_BYTES, uploadMenuImage } from '@/services/media_service';
import * as menu from '@/services/menu_service';

/**
 * Menu management. Manager and above throughout (FR-AUTH-3); routes validate
 * and map to HTTP, and hold no rules of their own — archiving, ordering and
 * deletion policy all live in menu_service.
 */
export const staffMenuRouter: Router = Router();

staffMenuRouter.use('/api/staff/menu', requireRole(StaffRole.MANAGER));

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: MAX_IMAGE_BYTES, files: 1 } });

const priceMinor = z.number().int().min(0, 'Price cannot be negative.');
const name = z.string().trim().min(1).max(120);
const description = z.string().trim().max(2000).nullish();

const categoryCreate = z.object({ name, description, isActive: z.boolean().optional() });
const categoryUpdate = categoryCreate.partial().refine((v) => Object.keys(v).length > 0, 'Nothing to update.');
const reorder = z.object({ ids: z.array(z.string().min(1)).min(1) });

const itemCreate = z.object({
  categoryId: z.string().min(1),
  name,
  description,
  basePriceMinor: priceMinor,
  isAvailable: z.boolean().optional(),
});
const itemUpdate = itemCreate.partial().refine((v) => Object.keys(v).length > 0, 'Nothing to update.');

const variantCreate = z.object({ name, priceMinor, isAvailable: z.boolean().optional() });
const variantUpdate = variantCreate.partial().refine((v) => Object.keys(v).length > 0, 'Nothing to update.');

const groupCreate = z.object({ name, minSelect: z.number().int().min(0), maxSelect: z.number().int().min(1) });
const groupUpdate = groupCreate.partial().refine((v) => Object.keys(v).length > 0, 'Nothing to update.');

const modifierCreate = z.object({ name, priceMinor, isAvailable: z.boolean().optional() });
const modifierUpdate = modifierCreate.partial().refine((v) => Object.keys(v).length > 0, 'Nothing to update.');

/** Parse a body against `schema`, or hand the ZodError to the error middleware. */
const parse = <T>(schema: z.ZodType<T>, body: unknown): T => schema.parse(body);

const requiredParam = (value: string | string[] | undefined, label: string): string => {
  if (typeof value !== 'string' || value.length === 0) throw new NotFoundError(`${label} not found.`);
  return value;
};

/** Wrap an async handler so a rejection reaches the error middleware. */
const handler =
  (fn: (req: Parameters<RequestHandler>[0], res: Parameters<RequestHandler>[1]) => Promise<void>): RequestHandler =>
  (req, res, next) => {
    fn(req, res).catch(next);
  };

const actorOf = (req: Parameters<RequestHandler>[0]) => {
  const user = req.user;
  if (!user) throw new BadRequestError('No session.');
  return user;
};

// ─── the whole menu, as a manager sees it ─────────────────────────────────

staffMenuRouter.get(
  '/api/staff/menu',
  handler(async (req, res) => {
    const categories = await menu.getManagedMenu(actorOf(req).branchId);
    res.json({ categories });
  }),
);

// ─── categories ───────────────────────────────────────────────────────────

staffMenuRouter.post(
  '/api/staff/menu/categories',
  handler(async (req, res) => {
    const actor = actorOf(req);
    const created = await menu.createCategory(actor.branchId, parse(categoryCreate, req.body));

    await audit({
      actor,
      action: 'menu.category_created',
      targetType: 'Category',
      targetId: created.id,
      after: created,
      requestId: req.id,
    });
    res.status(201).json({ category: created });
  }),
);

staffMenuRouter.patch(
  '/api/staff/menu/categories/:id',
  handler(async (req, res) => {
    const actor = actorOf(req);
    const id = requiredParam(req.params.id, 'Category');
    const { before, after } = await menu.updateCategory(id, parse(categoryUpdate, req.body));

    await audit({
      actor,
      action: 'menu.category_updated',
      targetType: 'Category',
      targetId: id,
      before,
      after,
      requestId: req.id,
    });
    res.json({ category: after });
  }),
);

staffMenuRouter.post(
  '/api/staff/menu/categories/reorder',
  handler(async (req, res) => {
    const actor = actorOf(req);
    const { ids } = parse(reorder, req.body);
    await menu.reorderCategories(actor.branchId, ids);

    await audit({ actor, action: 'menu.categories_reordered', targetType: 'Category', after: { ids }, requestId: req.id });
    res.status(204).end();
  }),
);

staffMenuRouter.post(
  '/api/staff/menu/categories/:id/archive',
  handler(async (req, res) => {
    const actor = actorOf(req);
    const id = requiredParam(req.params.id, 'Category');
    const { before, after } = await menu.archiveCategory(id);

    await audit({
      actor,
      action: 'menu.category_archived',
      targetType: 'Category',
      targetId: id,
      before,
      after,
      requestId: req.id,
    });
    res.json({ category: after });
  }),
);

staffMenuRouter.delete(
  '/api/staff/menu/categories/:id',
  handler(async (req, res) => {
    const actor = actorOf(req);
    const id = requiredParam(req.params.id, 'Category');
    const deleted = await menu.deleteCategory(id);

    await audit({
      actor,
      action: 'menu.category_deleted',
      targetType: 'Category',
      targetId: id,
      before: deleted,
      requestId: req.id,
    });
    res.status(204).end();
  }),
);

// ─── items ────────────────────────────────────────────────────────────────

staffMenuRouter.get(
  '/api/staff/menu/items/:id',
  handler(async (req, res) => {
    const item = await menu.getItem(requiredParam(req.params.id, 'Item'));
    res.json({ item });
  }),
);

staffMenuRouter.post(
  '/api/staff/menu/items',
  handler(async (req, res) => {
    const actor = actorOf(req);
    const created = await menu.createItem(parse(itemCreate, req.body));

    await audit({
      actor,
      action: 'menu.item_created',
      targetType: 'MenuItem',
      targetId: created.id,
      after: created,
      requestId: req.id,
    });
    res.status(201).json({ item: created });
  }),
);

staffMenuRouter.patch(
  '/api/staff/menu/items/:id',
  handler(async (req, res) => {
    const actor = actorOf(req);
    const id = requiredParam(req.params.id, 'Item');
    const { before, after } = await menu.updateItem(id, parse(itemUpdate, req.body));

    await audit({
      actor,
      action: 'menu.item_updated',
      targetType: 'MenuItem',
      targetId: id,
      before,
      after,
      requestId: req.id,
    });
    res.json({ item: after });
  }),
);

/*
 * Availability lives in `routes/staff/menu_availability.ts`, mounted ahead of
 * this router so a cashier can mark an item sold out mid-service without a
 * manager. Everything else here stays manager-and-above.
 */

staffMenuRouter.post(
  '/api/staff/menu/items/reorder',
  handler(async (req, res) => {
    const actor = actorOf(req);
    const { categoryId, ids } = parse(reorder.extend({ categoryId: z.string().min(1) }), req.body);
    await menu.reorderItems(categoryId, ids);

    await audit({
      actor,
      action: 'menu.items_reordered',
      targetType: 'MenuItem',
      targetId: categoryId,
      after: { ids },
      requestId: req.id,
    });
    res.status(204).end();
  }),
);

staffMenuRouter.post(
  '/api/staff/menu/items/:id/archive',
  handler(async (req, res) => {
    const actor = actorOf(req);
    const id = requiredParam(req.params.id, 'Item');
    const { before, after } = await menu.archiveItem(id);

    await audit({
      actor,
      action: 'menu.item_archived',
      targetType: 'MenuItem',
      targetId: id,
      before,
      after,
      requestId: req.id,
    });
    res.json({ item: after });
  }),
);

staffMenuRouter.delete(
  '/api/staff/menu/items/:id',
  handler(async (req, res) => {
    const actor = actorOf(req);
    const id = requiredParam(req.params.id, 'Item');
    const deleted = await menu.deleteItem(id);

    await audit({
      actor,
      action: 'menu.item_deleted',
      targetType: 'MenuItem',
      targetId: id,
      before: deleted,
      requestId: req.id,
    });
    res.status(204).end();
  }),
);

staffMenuRouter.post(
  '/api/staff/menu/items/:id/image',
  upload.single('image'),
  handler(async (req, res) => {
    const actor = actorOf(req);
    const id = requiredParam(req.params.id, 'Item');
    const file = req.file;
    if (!file) throw new BadRequestError('No image was uploaded.');

    const image = await uploadMenuImage(file);
    const item = await menu.setItemImage(id, image);

    await audit({
      actor,
      action: 'menu.item_image_set',
      targetType: 'MenuItem',
      targetId: id,
      after: { imageUrl: image.url },
      requestId: req.id,
    });
    res.json({ item });
  }),
);

// ─── variants ─────────────────────────────────────────────────────────────

staffMenuRouter.post(
  '/api/staff/menu/items/:id/variants',
  handler(async (req, res) => {
    const actor = actorOf(req);
    const id = requiredParam(req.params.id, 'Item');
    const created = await menu.createVariant(id, parse(variantCreate, req.body));

    await audit({
      actor,
      action: 'menu.variant_created',
      targetType: 'ItemVariant',
      targetId: created.id,
      after: created,
      requestId: req.id,
    });
    res.status(201).json({ variant: created });
  }),
);

staffMenuRouter.patch(
  '/api/staff/menu/variants/:id',
  handler(async (req, res) => {
    const actor = actorOf(req);
    const id = requiredParam(req.params.id, 'Variant');
    const { before, after } = await menu.updateVariant(id, parse(variantUpdate, req.body));

    await audit({
      actor,
      action: 'menu.variant_updated',
      targetType: 'ItemVariant',
      targetId: id,
      before,
      after,
      requestId: req.id,
    });
    res.json({ variant: after });
  }),
);

staffMenuRouter.delete(
  '/api/staff/menu/variants/:id',
  handler(async (req, res) => {
    const actor = actorOf(req);
    const id = requiredParam(req.params.id, 'Variant');
    const { before, after } = await menu.archiveVariant(id);

    await audit({
      actor,
      action: after ? 'menu.variant_archived' : 'menu.variant_deleted',
      targetType: 'ItemVariant',
      targetId: id,
      before,
      after,
      requestId: req.id,
    });
    res.status(204).end();
  }),
);

// ─── modifier groups and modifiers ────────────────────────────────────────

staffMenuRouter.post(
  '/api/staff/menu/items/:id/modifier-groups',
  handler(async (req, res) => {
    const actor = actorOf(req);
    const id = requiredParam(req.params.id, 'Item');
    const created = await menu.createModifierGroup(id, parse(groupCreate, req.body));

    await audit({
      actor,
      action: 'menu.modifier_group_created',
      targetType: 'ModifierGroup',
      targetId: created.id,
      after: created,
      requestId: req.id,
    });
    res.status(201).json({ group: created });
  }),
);

staffMenuRouter.patch(
  '/api/staff/menu/modifier-groups/:id',
  handler(async (req, res) => {
    const actor = actorOf(req);
    const id = requiredParam(req.params.id, 'Modifier group');
    const { before, after } = await menu.updateModifierGroup(id, parse(groupUpdate, req.body));

    await audit({
      actor,
      action: 'menu.modifier_group_updated',
      targetType: 'ModifierGroup',
      targetId: id,
      before,
      after,
      requestId: req.id,
    });
    res.json({ group: after });
  }),
);

staffMenuRouter.delete(
  '/api/staff/menu/modifier-groups/:id',
  handler(async (req, res) => {
    const actor = actorOf(req);
    const id = requiredParam(req.params.id, 'Modifier group');
    const deleted = await menu.deleteModifierGroup(id);

    await audit({
      actor,
      action: 'menu.modifier_group_deleted',
      targetType: 'ModifierGroup',
      targetId: id,
      before: deleted,
      requestId: req.id,
    });
    res.status(204).end();
  }),
);

staffMenuRouter.post(
  '/api/staff/menu/modifier-groups/:id/modifiers',
  handler(async (req, res) => {
    const actor = actorOf(req);
    const id = requiredParam(req.params.id, 'Modifier group');
    const created = await menu.createModifier(id, parse(modifierCreate, req.body));

    await audit({
      actor,
      action: 'menu.modifier_created',
      targetType: 'Modifier',
      targetId: created.id,
      after: created,
      requestId: req.id,
    });
    res.status(201).json({ modifier: created });
  }),
);

staffMenuRouter.patch(
  '/api/staff/menu/modifiers/:id',
  handler(async (req, res) => {
    const actor = actorOf(req);
    const id = requiredParam(req.params.id, 'Modifier');
    const { before, after } = await menu.updateModifier(id, parse(modifierUpdate, req.body));

    await audit({
      actor,
      action: 'menu.modifier_updated',
      targetType: 'Modifier',
      targetId: id,
      before,
      after,
      requestId: req.id,
    });
    res.json({ modifier: after });
  }),
);

staffMenuRouter.delete(
  '/api/staff/menu/modifiers/:id',
  handler(async (req, res) => {
    const actor = actorOf(req);
    const id = requiredParam(req.params.id, 'Modifier');
    const { before, after } = await menu.archiveModifier(id);

    await audit({
      actor,
      action: after ? 'menu.modifier_archived' : 'menu.modifier_deleted',
      targetType: 'Modifier',
      targetId: id,
      before,
      after,
      requestId: req.id,
    });
    res.status(204).end();
  }),
);
