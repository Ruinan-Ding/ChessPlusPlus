import { Routes } from '@angular/router';
import { LoginComponent } from './components/login/login.component';
import { LobbyComponent } from './components/lobby/lobby.component';
import { AuthGuard } from './guards/auth.guard';

export const routes: Routes = [
  { path: '', redirectTo: '/login', pathMatch: 'full' },
  { path: 'login', component: LoginComponent },
  { path: 'lobby', component: LobbyComponent, canActivate: [AuthGuard] },
  { path: '**', redirectTo: '/login' }
];
