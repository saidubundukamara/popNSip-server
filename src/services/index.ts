import * as authService from '@/services/auth_service';
import * as auditService from '@/services/audit_service';

/**
 * Service composition root. Routes import from here; as later phases land,
 * pricing, orders, payments and WhatsApp join the same object.
 */
export const services = {
  auth: authService,
  audit: auditService,
} as const;

export type Services = typeof services;
