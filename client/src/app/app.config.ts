import { ApplicationConfig, provideZoneChangeDetection } from '@angular/core';
import { provideRouter, withPreloading, PreloadAllModules } from '@angular/router';

import { routes } from './app.routes';

export const appConfig: ApplicationConfig = {
  providers: [
    provideZoneChangeDetection({ eventCoalescing: true }),
    // Every route here is lazy, so entering a game room paid for fetching its
    // chunk right when the player wanted to play. There are four small chunks
    // in total - pull them in the background once the app is up instead.
    provideRouter(routes, withPreloading(PreloadAllModules)),
  ],
};
