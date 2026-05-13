// Conector Shopify — pendiente de implementación.
// Docs: https://shopify.dev/docs/api/admin-rest
import type { IEcommerceIntegration, ProductPayload } from "../integration.interface";

export class ShopifyIntegration implements IEcommerceIntegration {
  constructor(private shopDomain: string, private accessToken: string) {}

  async createProduct(_product: ProductPayload): Promise<{ externalId: string }> {
    throw new Error("ShopifyIntegration.createProduct: not implemented yet");
  }

  async updateProduct(_externalId: string, _product: Partial<ProductPayload>): Promise<void> {
    throw new Error("ShopifyIntegration.updateProduct: not implemented yet");
  }

  async uploadImage(_imageUrl: string): Promise<string> {
    throw new Error("ShopifyIntegration.uploadImage: not implemented yet");
  }

  async productExistsBySku(_sku: string): Promise<boolean> {
    throw new Error("ShopifyIntegration.productExistsBySku: not implemented yet");
  }
}
