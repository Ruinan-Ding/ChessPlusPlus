import { Component, OnInit } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { Router } from '@angular/router';
import { ConfigService } from '../../services/config.service';
import { WebsocketService } from '../../services/websocket.service';

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
  username = '';
  
  constructor(
    private router: Router,
    private configService: ConfigService,
    private wsService: WebsocketService
  ) {}
  
  ngOnInit(): void {
    // Get username from localStorage
    this.username = localStorage.getItem('username') || '';
    console.log('SetupConfig ngOnInit: sending set_status configuring');
    // Set status to configuring
    this.wsService.sendMessage({
      type: 'set_status',
      username: this.username,
      status: 'configuring'
    });
    
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
      // Parse both JSON strings to objects first
      const currentConfigObj = JSON.parse(this.jsonConfig);
      const savedConfigObj = JSON.parse(this.savedConfig);
      
      // Compare the objects using deep equality
      return !this.deepEquals(currentConfigObj, savedConfigObj);
    } catch (error) {
      // If JSON parsing fails, compare as trimmed strings
      return this.jsonConfig.trim() !== this.savedConfig.trim();
    }
  }
  
  // Helper method for deep object comparison
  private deepEquals(obj1: any, obj2: any): boolean {
    // If primitives or one is null/undefined, direct comparison
    if (obj1 === obj2) return true;
    if (obj1 === null || obj2 === null) return false;
    if (obj1 === undefined || obj2 === undefined) return false;
    if (typeof obj1 !== 'object' || typeof obj2 !== 'object') return obj1 === obj2;
    
    // Arrays comparison
    if (Array.isArray(obj1) && Array.isArray(obj2)) {
      if (obj1.length !== obj2.length) return false;
      return obj1.every((val, idx) => this.deepEquals(val, obj2[idx]));
    }
    
    // Regular objects comparison
    const keys1 = Object.keys(obj1);
    const keys2 = Object.keys(obj2);
    
    if (keys1.length !== keys2.length) return false;
    
    return keys1.every(key => 
      keys2.includes(key) && this.deepEquals(obj1[key], obj2[key])
    );
  }

  onBack(): void {
    // Set a flag to indicate we're intentionally moving between pages
    localStorage.setItem('intentionalDisconnect', 'true');
    console.log('SetupConfig onBack: sending set_status online');
    // Set status to online before returning to lobby
    this.wsService.sendMessage({
      type: 'set_status',
      username: this.username,
      status: 'online'
    });
    
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

  formatJson(): void {
    try {
      const parsed = JSON.parse(this.jsonConfig);
      this.jsonConfig = JSON.stringify(parsed, null, 2);
      this.savedSuccessfully = false;
    } catch (e) {
      const errorMsg = typeof e === 'object' && e !== null && 'message' in e ? (e as Error).message : String(e);
      alert('Invalid JSON: ' + errorMsg);
    }
  }
}