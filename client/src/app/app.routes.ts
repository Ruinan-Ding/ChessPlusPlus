import { Routes } from '@angular/router';
import { AuthGuard } from './guards/auth.guard';

export const routes: Routes = [
  {
    path: '',
    redirectTo: '/login',
    pathMatch: 'full'
  },
  {
    path: 'login',
    loadComponent: () => import('./components/login/login.component').then(m => m.LoginComponent)
  },
  {
    path: 'lobby',
    loadComponent: () => import('./components/lobby/lobby.component').then(m => m.LobbyComponent),
    canActivate: [AuthGuard]
  },
  {
    path: 'setup',
    loadComponent: () => import('./components/setup-config/setup-config.component').then(m => m.SetupConfigComponent),
    canActivate: [AuthGuard]
  }
];
