export const sampleSets = {
 commerce: {
  title: 'Commerce', icon: 'shop', filename: 'fetchx-commerce-sample.csv', description: 'A consistent view of products, prices and availability.',
  columns: [['product_id','Product ID'],['title','Product'],['price','Price'],['currency','Currency'],['availability','Availability'],['source_url','Source URL'],['collected_at','Collected at']],
  records: [
   {product_id:'FX–001',title:'Everyday carry tote',price:48,currency:'USD',availability:'In stock',source_url:'https://store.example/products/tote',collected_at:'2026-10-28T09:00:00Z'},
   {product_id:'FX–002',title:'Stoneware coffee set',price:32.5,currency:'USD',availability:'In stock',source_url:'https://store.example/products/coffee-set',collected_at:'2026-10-28T09:00:00Z'},
   {product_id:'FX–003',title:'Arc desk lamp',price:79,currency:'USD',availability:'Out of stock',source_url:'https://store.example/products/arc-lamp',collected_at:'2026-10-28T09:00:00Z'},
   {product_id:'FX–004',title:'Canvas weekend bag',price:96,currency:'USD',availability:'In stock',source_url:'https://store.example/products/weekend-bag',collected_at:'2026-10-28T09:00:00Z'}
  ]
 },
 property: {
  title:'Property',icon:'house',filename:'fetchx-property-sample.csv',description:'Listing details, organised around the fields your team needs.',
  columns:[['listing_id','Listing ID'],['city','City'],['asking_price','Asking price'],['currency','Currency'],['area_sqm','Area (m²)'],['status','Status'],['source_url','Source URL'],['collected_at','Collected at']],
  records:[
   {listing_id:'DEMO–101',city:'Dubai',asking_price:1300000,currency:'AED',area_sqm:146,status:'Available',source_url:'https://property.example/listings/101',collected_at:'2026-10-28T09:00:00Z'},
   {listing_id:'DEMO–102',city:'Abu Dhabi',asking_price:1850000,currency:'AED',area_sqm:172,status:'Available',source_url:'https://property.example/listings/102',collected_at:'2026-10-28T09:00:00Z'},
   {listing_id:'DEMO–103',city:'Sharjah',asking_price:780000,currency:'AED',area_sqm:105,status:'Unavailable',source_url:'https://property.example/listings/103',collected_at:'2026-10-28T09:00:00Z'},
   {listing_id:'DEMO–104',city:'Dubai',asking_price:2100000,currency:'AED',area_sqm:188,status:'Available',source_url:'https://property.example/listings/104',collected_at:'2026-10-28T09:00:00Z'}
  ]
 },
 logistics:{
  title:'Logistics',icon:'route',filename:'fetchx-logistics-sample.csv',description:'Shipment milestones with the context to make sense of them.',
  columns:[['shipment_ref','Shipment'],['milestone','Milestone'],['location','Location'],['event_time','Event time'],['source_url','Source URL'],['collected_at','Collected at']],
  records:[
   {shipment_ref:'DEMO–001',milestone:'Arrived',location:'Singapore',event_time:'2026-10-28T06:30:00Z',source_url:'https://carrier.example/shipments/001',collected_at:'2026-10-28T09:00:00Z'},
   {shipment_ref:'DEMO–002',milestone:'Departed',location:'Jebel Ali',event_time:'2026-10-28T07:15:00Z',source_url:'https://carrier.example/shipments/002',collected_at:'2026-10-28T09:00:00Z'},
   {shipment_ref:'DEMO–003',milestone:'Discharged',location:'Rotterdam',event_time:'2026-10-28T08:20:00Z',source_url:'https://carrier.example/shipments/003',collected_at:'2026-10-28T09:00:00Z'},
   {shipment_ref:'DEMO–004',milestone:'In transit',location:'Colombo',event_time:'2026-10-28T08:45:00Z',source_url:'https://carrier.example/shipments/004',collected_at:'2026-10-28T09:00:00Z'}
  ]
 }
} as const;
export type SampleKey = keyof typeof sampleSets;
