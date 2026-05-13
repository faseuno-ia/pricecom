// Conector TiendaNube — pendiente de implementación.
// Docs: https://tiendanube.github.io/api-documentation/
import type { IEcommerceIntegration, ProductPayload } from "../integration.interface";

export class TiendaNubeIntegration implements IEcommerceIntegration {
  constructor(private storeId: string, private accessToken: string) {}

  async createProduct(_product: ProductPayload): Promise<{ externalId: string }> {
    throw new Error("TiendaNubeIntegration.createProduct: not implemented yet");
  }

  async updateProduct(_externalId: string, _product: Partial<ProductPayload>): Promise<void> {
    throw new Error("TiendaNubeIntegration.updateProduct: not implemented yet");
  }

  async uploadImage(_imageUrl: string): Promise<string> {
    throw new Error("TiendaNubeIntegration.uploadImage: not implemented yet");
  }

  async productExistsBySku(_sku: string): Promise<boolean> {
    throw new Error("TiendaNubeIntegration.productExistsBySku: not implemented yet");
  }
}
