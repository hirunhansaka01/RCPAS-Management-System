import { seedReferenceData } from './provision.js';

await seedReferenceData();
console.log('Reference data seeded without replacing existing records.');
process.exit(0);
