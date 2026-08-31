/* eslint-disable @typescript-eslint/no-explicit-any -- Prisma has no single
   generic model type, so the shared delegate shape below is necessarily loose.
   The `any`s are confined to this file; every concrete repository above it is
   fully typed through its own delegate. */

import type { Prisma, PrismaClient } from '@/generated/prisma/client';

export type TxClient = Prisma.TransactionClient;
export type DbClient = PrismaClient | TxClient;

/** The structural shape every Prisma model delegate shares. */
export interface ModelDelegate<TSelect, TCreate, TUpdate, TWhere, TWhereUnique, TOrderBy> {
  findUnique(args: { where: TWhereUnique; include?: unknown }): Promise<TSelect | null>;
  findFirst(args?: { where?: TWhere; orderBy?: TOrderBy; include?: unknown }): Promise<TSelect | null>;
  findMany(args?: {
    where?: TWhere;
    orderBy?: TOrderBy | TOrderBy[];
    take?: number;
    skip?: number;
    include?: unknown;
  }): Promise<TSelect[]>;
  create(args: { data: TCreate }): Promise<TSelect>;
  createMany(args: { data: TCreate[] }): Promise<{ count: number }>;
  update(args: { where: TWhereUnique; data: TUpdate }): Promise<TSelect>;
  updateMany(args: { where: TWhere; data: TUpdate }): Promise<{ count: number }>;
  delete(args: { where: TWhereUnique }): Promise<TSelect>;
  count(args?: { where?: TWhere }): Promise<number>;
}

export type AnyModelDelegate = ModelDelegate<any, any, any, any, any, any>;

/**
 * All Prisma access lives in repositories. A repository returns plain data:
 * it never sends a WhatsApp message, never emits SSE, and never throws a
 * domain error — those belong to the service above it.
 *
 * Every repository can be rebound to a transaction with `withTx`, which is how
 * a service composes several of them into one atomic write.
 */
export abstract class BaseRepository<D extends AnyModelDelegate, TModel> {
  constructor(protected readonly db: DbClient) {}

  /** Each subclass names its delegate; `withTx` re-binds it to a transaction. */
  protected abstract delegate(db: DbClient): D;

  /** Return a repository of the same kind bound to `tx`. */
  abstract withTx(tx: TxClient): this;

  protected get model(): D {
    return this.delegate(this.db);
  }

  findById(id: string): Promise<TModel | null> {
    return this.model.findUnique({ where: { id } as any });
  }

  findMany(args?: Parameters<D['findMany']>[0]): Promise<TModel[]> {
    return this.model.findMany(args as any);
  }

  create(data: Parameters<D['create']>[0]['data']): Promise<TModel> {
    return this.model.create({ data } as any);
  }

  update(id: string, data: Parameters<D['update']>[0]['data']): Promise<TModel> {
    return this.model.update({ where: { id } as any, data } as any);
  }

  count(where?: Parameters<D['count']>[0] extends { where?: infer W } ? W : never): Promise<number> {
    return this.model.count({ where } as any);
  }

  async exists(where: Parameters<D['count']>[0] extends { where?: infer W } ? W : never): Promise<boolean> {
    return (await this.model.count({ where } as any)) > 0;
  }
}
