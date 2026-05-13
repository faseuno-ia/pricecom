// Conector WooCommerce — pendiente de implementación.
// Docs: https://woocommerce.github.io/woocommerce-rest-api-docs/
import type { IEcommerceIntegration, ProductPayload } from "../integration.interface";

export class WooCommerceIntegration implements IEcommerceIntegration {
  constructor(
    private siteUrl: string,
    private consumerKey: string,
    private consumerSecret: string
  ) {}

  async createProduct(_product: ProductPayload): Promise<{ externalId: string }> {
    throw new Error("WooCommerceIntegration.createProduct: not implemented yet");
  }

  async updateProduct(_externalId: string, _product: Partial<ProductPayload>): Promise<void> {
    throw new Error("WooCommerceIntegration.updateProduct: not implemented yet");
  }

  async uploadImage(_imageUrl: string): Promise<string> {
    throw new Error("WooCommerceIntegration.uploadImage: not implemented yet");
  }

  async productExistsBySku(_sku: string): Promise<boolean> {
    throw new Error("WooCommerceIntegration.productExistsBySku: not implemented yet");
  }
}
