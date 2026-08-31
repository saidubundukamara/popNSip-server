import { OrderChannel, OrderType, PaymentMethod } from '@/generated/prisma/enums';
import { env } from '@/config/env';
import { logger } from '@/lib/logger';
import { formatMinor } from '@/lib/money';
import { buttonMessage, orderPlaced, ussdInstruction } from '@/lib/whapi_templates';
import { updateSession } from '@/services/bot_session_service';
import { createOrder } from '@/services/order_service';
import { createMobileMoneyPayment } from '@/services/payment_service';
import { toCartLines } from '@/services/whatsapp_helpers/cart_state';
import { reply, replyInteractive, type BotContext, type SessionData } from '@/services/whatsapp_helpers/context';

/**
 * The three questions between a confirmed cart and an order: how they want it,
 * where it goes, and how they are paying.
 */

// ─── order type ───────────────────────────────────────────────────────────

export async function askOrderType(context: BotContext): Promise<void> {
  const branch = context.branch;
  const buttons = [
    ...(branch.deliveryEnabled ? [{ id: 'type_delivery', title: 'Delivery' }] : []),
    ...(branch.pickupEnabled ? [{ id: 'type_pickup', title: 'Pickup' }] : []),
    ...(branch.dineInEnabled ? [{ id: 'type_dinein', title: 'Dine-in' }] : []),
  ];

  if (buttons.length === 0) {
    await reply(context, 'We are not taking orders right now. Please try again a little later.');
    return;
  }

  updateSession({ intent: 'order_type', step: null });

  await replyInteractive(
    context,
    buttonMessage({ phoneE164: context.phoneE164, body: 'How would you like your order?', buttons }),
    'How would you like your order?',
  );
}

const TYPE_BY_SELECTION: Record<string, OrderType> = {
  type_delivery: OrderType.DELIVERY,
  type_pickup: OrderType.PICKUP,
  type_dinein: OrderType.DINE_IN,
};

export async function handleOrderTypeReply(context: BotContext): Promise<void> {
  const orderType = context.selection ? TYPE_BY_SELECTION[context.selection] : undefined;

  if (!orderType) {
    await askOrderType(context);
    return;
  }

  if (orderType === OrderType.DELIVERY) {
    updateSession({ intent: 'address', step: 'address', metadata: { orderType } });
    await reply(context, 'What is the delivery address?');
    return;
  }

  if (orderType === OrderType.DINE_IN) {
    updateSession({ intent: 'address', step: 'table', metadata: { orderType } });
    await reply(context, 'Which table are you at? The code is on the sticker, like T4.');
    return;
  }

  updateSession({ metadata: { orderType } });
  await askPayment(context);
}

// ─── where ────────────────────────────────────────────────────────────────

export async function handleAddressReply(context: BotContext, data: SessionData): Promise<void> {
  const text = context.text;

  if (!text) {
    await reply(context, 'Please type it as a message and I will note it down.');
    return;
  }

  if (data.orderType === OrderType.DINE_IN) {
    updateSession({ metadata: { tableCode: text.trim().toUpperCase() } });
    await askPayment(context);
    return;
  }

  // Address then landmark: a Freetown address without a landmark is a rider
  // phoning the customer, every time.
  if (!data.deliveryAddress) {
    updateSession({ step: 'landmark', metadata: { deliveryAddress: text.trim() } });
    await reply(context, 'Any landmark or directions to help the rider find you? Type *skip* if not.');
    return;
  }

  const notes = text.trim().toLowerCase() === 'skip' ? '' : text.trim();
  updateSession({ metadata: { deliveryNotes: notes } });
  await askPayment(context);
}

// ─── payment ──────────────────────────────────────────────────────────────

export async function askPayment(context: BotContext): Promise<void> {
  updateSession({ intent: 'payment', step: null });

  await replyInteractive(
    context,
    buttonMessage({
      phoneE164: context.phoneE164,
      body: 'How would you like to pay?',
      buttons: [
        { id: 'pay_momo', title: 'Mobile money' },
        { id: 'pay_cash', title: 'Cash' },
      ],
    }),
    'How would you like to pay?',
  );
}

export async function handlePaymentReply(context: BotContext, data: SessionData): Promise<void> {
  const method =
    context.selection === 'pay_momo'
      ? PaymentMethod.MOBILE_MONEY
      : context.selection === 'pay_cash'
        ? PaymentMethod.CASH
        : null;

  if (!method) {
    await askPayment(context);
    return;
  }

  const lines = data.lines ?? [];
  if (lines.length === 0) {
    await reply(context, 'Your order is empty. Type *menu* to start again.');
    updateSession({ intent: 'start', step: null, metadata: { lines: [] } });
    return;
  }

  try {
    const { order } = await createOrder({
      branchId: context.branch.id,
      channel: OrderChannel.WHATSAPP,
      type: data.orderType ?? OrderType.PICKUP,
      paymentMethod: method,
      lines: toCartLines(lines),
      customer: { name: context.customerName, phone: context.phoneE164 },
      ...(data.deliveryAddress ? { deliveryAddress: data.deliveryAddress } : {}),
      ...(data.deliveryNotes ? { deliveryNotes: data.deliveryNotes } : {}),
      ...(data.tableCode ? { tableCode: data.tableCode } : {}),
    });

    // The conversation is over; the order takes it from here.
    updateSession({ intent: 'start', step: null, metadata: { lines: [], orderType: undefined } });

    await reply(context, orderPlaced(order.reference, `${env.APP_BASE_URL}/orders/track/${order.trackingToken}`));

    if (method === PaymentMethod.MOBILE_MONEY) {
      await sendPaymentCode(context, order.id, order.totalMinor);
    } else {
      const when =
        data.orderType === OrderType.DELIVERY
          ? 'when the rider arrives'
          : data.orderType === OrderType.DINE_IN
            ? 'when you settle up'
            : 'when you collect';
      await reply(
        context,
        `Please have ${formatMinor(order.totalMinor, context.branch.currency)} ready ${when}.`,
      );
    }
  } catch (error) {
    // The order was refused for a reason the customer can act on — usually an
    // item that has just sold out. Say what happened rather than "error".
    logger.warn({ err: error }, 'Could not place a WhatsApp order');
    await reply(
      context,
      error instanceof Error && error.message
        ? `${error.message}\n\nType *menu* to start again.`
        : 'I could not place that order. Type *menu* to try again.',
    );
    updateSession({ intent: 'start', step: null, metadata: { lines: [] } });
  }
}

async function sendPaymentCode(context: BotContext, orderId: string, totalMinor: number): Promise<void> {
  try {
    const payment = await createMobileMoneyPayment({ orderId, phoneE164: context.phoneE164 });

    if (payment.ussdCode) {
      await reply(context, ussdInstruction(payment.ussdCode, payment.amountMinor, context.branch.currency));
      return;
    }

    await reply(context, 'I could not get a payment code just now. The restaurant will be in touch.');
  } catch (error) {
    // The order exists and is recorded; only the code failed. Never leave the
    // customer thinking the order did not land.
    logger.warn({ err: error, orderId }, 'Could not create a payment code for a WhatsApp order');
    await reply(
      context,
      `Your order is placed for ${formatMinor(totalMinor, context.branch.currency)}, but I could not send a payment code. The restaurant will follow up here.`,
    );
  }
}
