/**
 * Whapi.cloud wire types.
 *
 * Shapes come from byn2_v2's working integration and Whapi's documentation.
 * Where a field is inferred rather than observed it is marked, because
 * guessing a field name here costs an afternoon.
 */

// ─── inbound ──────────────────────────────────────────────────────────────

/** A row or button reply. Ids come back PREFIXED — see stripReplyPrefix. */
export type WhapiReply = {
  type?: string;
  buttons_reply?: { id?: string; title?: string };
  list_reply?: { id?: string; title?: string; description?: string };
};

/**
 * A native catalog cart, sent as a message of type "order".
 *
 * `preview` is base64 image data and must never be logged.
 */
export type WhapiOrderMessage = {
  order_id?: string;
  token?: string;
  item_count?: number;
  currency?: string;
  total_price?: number;
  status?: string;
  preview?: string;
  seller?: string;
};

export type WhapiInboundMessage = {
  id?: string;
  /** Digits only, no '+'. */
  from?: string;
  from_me?: boolean;
  from_name?: string;
  type?: string;
  timestamp?: number;
  chat_id?: string;
  text?: { body?: string };
  reply?: WhapiReply;
  order?: WhapiOrderMessage;
  image?: { link?: string; caption?: string };
};

export type WhapiWebhookBody = {
  messages?: WhapiInboundMessage[];
  statuses?: unknown[];
  event?: { type?: string; event?: string };
  channel_id?: string;
};

/** A line of a catalog cart, from GET /business/orders/{id}. */
export type WhapiOrderItem = {
  /** Our own MenuItem id — this is how a cart line maps back. */
  product_retailer_id?: string;
  product_id?: string;
  name?: string;
  quantity?: number;
  /** Major units, as a decimal. */
  price?: number;
  currency?: string;
};

export type WhapiOrderDetails = {
  id?: string;
  items?: WhapiOrderItem[];
  /** Display data. Never the charge — pricing_service decides that. */
  total_price?: number;
  currency?: string;
};

// ─── outbound ─────────────────────────────────────────────────────────────

export type WhapiListRow = { id: string; title: string; description?: string };
export type WhapiListSection = { title: string; rows: WhapiListRow[] };

export type WhapiInteractivePayload =
  | {
      to: string;
      type: 'list';
      header?: { text: string };
      body: { text: string };
      footer?: { text: string };
      action: { list: { label: string; sections: WhapiListSection[] } };
    }
  | {
      to: string;
      type: 'button';
      header?: { text: string };
      body: { text: string };
      footer?: { text: string };
      action: { buttons: { type: 'quick_reply'; id: string; title: string }[] };
    };

/** POST /business/products. `price` is a DECIMAL in major units. */
export type WhapiProductInput = {
  name: string;
  price: number;
  currency: string;
  description?: string;
  images?: string[];
  product_retailer_id: string;
  availability: 'in stock' | 'out of stock';
  url?: string;
  is_hidden?: boolean;
};

export type WhapiProduct = { id?: string; product_retailer_id?: string } & Partial<WhapiProductInput>;

export type WhapiBusinessProfile = {
  id?: string;
  address?: string;
  description?: string;
  email?: string;
  websites?: string[];
  hours?: unknown;
};
