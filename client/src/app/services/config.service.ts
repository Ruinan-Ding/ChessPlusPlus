import { Injectable } from '@angular/core';
import { BehaviorSubject, Observable } from 'rxjs';

@Injectable({
  providedIn: 'root'
})
export class ConfigService {
  // Template for default configuration
  private readonly defaultConfig = {
    version: '1.0',
    units: {
      // Placeholder for unit configurations
      // Will be expanded later with actual game rules
    },
    abilities: {
      // Placeholder for ability configurations
      // Will be expanded later with actual game rules
    }
  };

  private configSubject = new BehaviorSubject<any>(this.defaultConfig);
  public config$ = this.configSubject.asObservable();

  constructor() {}

  getDefaultConfig(): string {
    return JSON.stringify(this.defaultConfig, null, 2);
  }

  validateJsonSyntax(jsonString: string): boolean {
    try {
      JSON.parse(jsonString);
      return true;
    } catch (e) {
      return false;
    }
  }

  // This will be expanded later with actual game rules
  validateGameRules(config: any): { valid: boolean; errors?: string[] } {
    // Placeholder for game rule validation
    // For now, just check if it has the basic structure
    if (!config.version || !config.units || !config.abilities) {
      return {
        valid: false,
        errors: ['Configuration must include version, units, and abilities']
      };
    }
    return { valid: true };
  }

  updateConfig(jsonString: string): { valid: boolean; errors?: string[] } {
    // First validate JSON syntax
    if (!this.validateJsonSyntax(jsonString)) {
      return {
        valid: false,
        errors: ['Invalid JSON syntax']
      };
    }

    const config = JSON.parse(jsonString);
    
    // Then validate game rules
    const gameValidation = this.validateGameRules(config);
    if (!gameValidation.valid) {
      return gameValidation;
    }

    // If all validation passes, update the configuration
    this.configSubject.next(config);
    return { valid: true };
  }
}