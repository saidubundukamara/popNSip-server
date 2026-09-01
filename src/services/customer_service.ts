import { NotFoundError } from '@/lib/errors';
import { phoneSearchFragment } from '@/lib/phone';
import { repositories as repos } from '@/repositories';

/**
 * Customers (FR-CUST). They are keyed by phone number, so a search term is
 * tried both as text and as a phone fragment — staff type '077 900100' for a
 * number stored as '+23277900100'.
 */
export async function listCustomers(term?: string, take = 50) {
  if (!term) return repos.customers.recent(take);

  const fragment = phoneSearchFragment(term);
  return repos.customers.searchByNameOrPhone(term, fragment ?? undefined, take);
}

export async function getCustomer(id: string) {
  const customer = await repos.customers.findByIdWithOrders(id);
  if (!customer) throw new NotFoundError('Customer not found.');
  return customer;
}
