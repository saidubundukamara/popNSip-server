import { prisma } from '@/db/client';
import { AuditLogRepository } from '@/repositories/audit_log.repository';
import { BranchRepository } from '@/repositories/branch.repository';
import { CategoryRepository } from '@/repositories/category.repository';
import { CustomerRepository } from '@/repositories/customer.repository';
import { ItemVariantRepository } from '@/repositories/item_variant.repository';
import { MenuItemRepository } from '@/repositories/menu_item.repository';
import { OrderRepository } from '@/repositories/order.repository';
import { ModifierRepository } from '@/repositories/modifier.repository';
import { ModifierGroupRepository } from '@/repositories/modifier_group.repository';
import { OrderAdjustmentRepository } from '@/repositories/order_adjustment.repository';
import { OrderStatusEventRepository } from '@/repositories/order_status_event.repository';
import { PaymentRepository } from '@/repositories/payment.repository';
import { StaffUserRepository } from '@/repositories/staff_user.repository';
import { WebhookEventRepository } from '@/repositories/webhook_event.repository';
import { WhatsAppConversationRepository } from '@/repositories/wa_conversation.repository';

/**
 * Composition root. Each repository is instantiated once against the shared
 * client; services import from here rather than constructing their own.
 *
 * Inside a transaction a service rebinds the ones it needs:
 *
 *   await prisma.$transaction(async (tx) => {
 *     const order = await repositories.orders.withTx(tx).create(…);
 *     await repositories.statusEvents.withTx(tx).create(…);
 *   });
 */
export const repositories = {
  audit: new AuditLogRepository(prisma),
  branches: new BranchRepository(prisma),
  categories: new CategoryRepository(prisma),
  conversations: new WhatsAppConversationRepository(prisma),
  customers: new CustomerRepository(prisma),
  itemVariants: new ItemVariantRepository(prisma),
  menuItems: new MenuItemRepository(prisma),
  modifierGroups: new ModifierGroupRepository(prisma),
  modifiers: new ModifierRepository(prisma),
  adjustments: new OrderAdjustmentRepository(prisma),
  orders: new OrderRepository(prisma),
  payments: new PaymentRepository(prisma),
  staffUsers: new StaffUserRepository(prisma),
  statusEvents: new OrderStatusEventRepository(prisma),
  webhookEvents: new WebhookEventRepository(prisma),
} as const;

export type Repositories = typeof repositories;
