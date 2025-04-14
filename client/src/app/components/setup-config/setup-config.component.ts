import { Component, OnInit } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { Router } from '@angular/router';
import { ConfigService } from '../../services/config.service';

@Component({
  selector: 'app-setup-config',
  standalone: true,
  imports: [CommonModule, FormsModule],
  templateUrl: './setup-config.component.html',
  styleUrls: ['./setup-config.component.scss']
})
export class SetupConfigComponent implements OnInit {
  jsonConfig = '';
  savedConfig = '';
  savedSuccessfully = false;
  
  constructor(
    private router: Router,
    private configService: ConfigService
  ) {}
  
  ngOnInit(): void {
    // Initialize with default config
    this.jsonConfig = this.configService.getDefaultConfig();
    this.savedConfig = this.jsonConfig;
    
    // Subscribe to config changes (will be used when UI is implemented)
    this.configService.config$.subscribe(config => {
      // Only update if the stringified value is different to avoid cycles
      const newJsonString = JSON.stringify(config, null, 2);
      if (this.jsonConfig !== newJsonString) {
        this.jsonConfig = newJsonString;
      }
    });
  }

  get hasUnsavedChanges(): boolean {
    try {
      // If both are valid JSON, compare their parsed form to ignore formatting differences
      const currentConfig = JSON.stringify(JSON.parse(this.jsonConfig));
      const savedConfig = JSON.stringify(JSON.parse(this.savedConfig));
      return currentConfig !== savedConfig;
    } catch {
      // If either JSON is invalid, compare as strings
      return this.jsonConfig.trim() !== this.savedConfig.trim();
    }
  }

  onBack(): void {
    if (this.hasUnsavedChanges) {
      if (confirm('You have unsaved changes. Do you want to save before going back?')) {
        if (this.saveConfig()) {
          this.router.navigate(['/lobby']);
        }
      } else {
        this.router.navigate(['/lobby']);
      }
    } else {
      this.router.navigate(['/lobby']);
    }
  }

  saveConfig(): boolean {
    const result = this.configService.updateConfig(this.jsonConfig);
    
    if (!result.valid) {
      alert(result.errors?.join('\n') || 'Invalid configuration');
      return false;
    }
    
    this.savedConfig = this.jsonConfig;
    this.savedSuccessfully = true;
    // Reset saved message after 2 seconds
    setTimeout(() => {
      this.savedSuccessfully = false;
    }, 2000);
    
    return true;
  }

  onConfigChange(): void {
    // Only update saved state if there are actual changes
    this.savedSuccessfully = false;
  }
}