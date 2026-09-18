export type Condition = "new" | "demo" | "refurb" | "open-box" | "returned" | null;

export interface AdapterListing {
  id: string;
  name: string;
  price: number;
  currency: string;
  condition: Condition;
  url: string;
}

export type AdapterName = "maxgaming" | "proshop";

export interface Adapter {
  name: AdapterName;
  scrape(searchUrl: string): Promise<AdapterListing[]>;
}
