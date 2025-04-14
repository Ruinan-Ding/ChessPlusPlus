import { Component, OnInit } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { Router } from '@angular/router';

@Component({
  selector: 'app-setup-config',
  standalone: true,
  imports: [CommonModule, FormsModule],
  templateUrl: './setup-config.component.html',
  styleUrls: ['./setup-config.component.scss']
})
export class SetupConfigComponent implements OnInit {
  hasUnsavedChanges = false;
  jsonConfig = '';
  
  constructor(private router: Router) {}
  
  ngOnInit(): void {
    // Initialize with default config or load saved config
  }

  onBack(): void {
    if (this.hasUnsavedChanges) {
      if (confirm('You have unsaved changes. Do you want to save before going back?')) {
        this.saveConfig();
      }
    }
    this.router.navigate(['/lobby']);
  }

  saveConfig(): void {
    if (this.validateConfig()) {
      // Save configuration
      this.hasUnsavedChanges = false;
    }
  }

  private validateConfig(): boolean {
    try {
      const config = JSON.parse(this.jsonConfig);
      // Add validation rules here
      return true;
    } catch (e) {
      alert('Invalid JSON configuration');
      return false;
    }
  }

  onConfigChange(): void {
    this.hasUnsavedChanges = true;
  }
}