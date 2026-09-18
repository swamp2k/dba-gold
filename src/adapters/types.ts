export type Condition = "new" | "demo" | "refurb" | "open-box" | "returned" | "used" | null;

export interface AdapterListing {
  id: string;
  name: string;
  price: number;
  originalPrice: number | null;
  currency: string;
  condition: Condition;
  url: string;
}

export type AdapterName = "maxgaming" | "proshop";

export interface Adapter {
  name: AdapterName;
  scrape(searchUrl: string): Promise<AdapterListing[]>;
}
