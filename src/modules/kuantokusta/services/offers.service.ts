import { Injectable } from '@nestjs/common'

import { PrismaService } from '#/infra/database/prisma.service'

/** One of the store's offers on KuantoKusta, as the plugin sees it. */
export interface OfferView {
  /** Opaque id of the offer in the hub. Also the cursor for the next page. */
  id: string
  offerRef: string
  sku: string | null
  ean: string | null
  name: string
  /** The product page on the store's own site. */
  storeUrl: string
  /** The product page on KuantoKusta. */
  productUrl: string
  priceCents: number
  stock: number
  isTopBox: boolean
  listingStatus: 'listed' | 'delisted'
  kkUpdatedAt: Date | null
  lastSeenAt: Date
}

export interface OffersPage {
  offers: OfferView[]
  /** Pass it as `after` to get the next page. Null on the last page. */
  nextCursor: string | null
}

export interface OffersQuery {
  limit: number
  /** The `nextCursor` of the previous page. */
  after?: bigint
  status: 'listed' | 'delisted' | 'all'
}

@Injectable()
export class OffersService {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * A page of the store's offers, oldest id first.
   *
   * Paging follows the id instead of counting rows to skip, so a page costs
   * the same however deep it is and a sync running meanwhile neither repeats
   * nor hides an offer.
   */
  async list(storeId: string, query: OffersQuery): Promise<OffersPage> {
    const rows = await this.prisma.withStore(storeId, (tx) =>
      tx.kk_store_offers.findMany({
        where: {
          ...(query.after === undefined ? {} : { id: { gt: query.after } }),
          ...(query.status === 'all' ? {} : { listing_status: query.status })
        },
        orderBy: { id: 'asc' },
        // One extra row tells whether there is a next page.
        take: query.limit + 1,
        select: {
          id: true,
          kk_offer_ref: true,
          sku: true,
          ean: true,
          name: true,
          store_url: true,
          price_cents: true,
          stock: true,
          is_top_box: true,
          listing_status: true,
          kk_updated_at: true,
          last_seen_at: true,
          kk_products: { select: { url: true } }
        }
      })
    )

    const page = rows.slice(0, query.limit)
    return {
      offers: page.map((row) => ({
        id: row.id.toString(),
        offerRef: row.kk_offer_ref,
        sku: row.sku,
        ean: row.ean,
        name: row.name,
        storeUrl: row.store_url,
        productUrl: row.kk_products.url,
        priceCents: row.price_cents,
        stock: row.stock,
        isTopBox: row.is_top_box,
        listingStatus: row.listing_status === 'delisted' ? 'delisted' : 'listed',
        kkUpdatedAt: row.kk_updated_at,
        lastSeenAt: row.last_seen_at
      })),
      nextCursor: rows.length > query.limit
        ? page[page.length - 1].id.toString()
        : null
    }
  }

  /** How many offers the store has, by listing status. */
  async count(storeId: string): Promise<{ listed: number, delisted: number }> {
    const groups = await this.prisma.withStore(storeId, (tx) =>
      tx.kk_store_offers.groupBy({
        by: ['listing_status'],
        _count: { _all: true }
      })
    )
    const of = (status: string) =>
      groups.find((group) => group.listing_status === status)?._count._all ?? 0
    return { listed: of('listed'), delisted: of('delisted') }
  }
}
