import type {
  CommandDefinition,
  ComponentDefinition,
  ModuleDefinition,
  UiComponentInstance,
  UiSurfaceDocumentV2,
} from "./types";

export class CompositionRegistry {
  private readonly modules = new Map<string, ModuleDefinition>();
  private readonly components = new Map<string, ComponentDefinition>();
  private readonly commands = new Map<string, CommandDefinition>();

  registerModule(definition: ModuleDefinition): () => void {
    return registerUnique(this.modules, definition.id, freeze(definition), "module");
  }

  registerComponent(definition: ComponentDefinition): () => void {
    if (!this.modules.has(definition.moduleId)) {
      throw new Error(`component ${definition.type} references unknown module ${definition.moduleId}`);
    }
    return registerUnique(
      this.components,
      definition.type,
      freeze({
        ...definition,
        slots: [...definition.slots],
        events: [...definition.events],
        ...(definition.eventCommands
          ? {
              eventCommands: Object.fromEntries(
                Object.entries(definition.eventCommands).map(([event, commands]) => [
                  event,
                  [...commands],
                ]),
              ),
            }
          : {}),
        ...(definition.columnSpans
          ? { columnSpans: [...definition.columnSpans] }
          : {}),
        ...(definition.rowSpans ? { rowSpans: [...definition.rowSpans] } : {}),
      }),
      "component",
    );
  }

  registerCommand(definition: CommandDefinition): () => void {
    if (!this.modules.has(definition.moduleId)) {
      throw new Error(`command ${definition.id} references unknown module ${definition.moduleId}`);
    }
    return registerUnique(this.commands, definition.id, freeze(definition), "command");
  }

  component(type: string): ComponentDefinition | undefined {
    return this.components.get(type);
  }

  command(id: string): CommandDefinition | undefined {
    return this.commands.get(id);
  }

  listModules(): readonly ModuleDefinition[] {
    return [...this.modules.values()];
  }

  listComponents(): readonly ComponentDefinition[] {
    return [...this.components.values()];
  }

  listCommands(): readonly CommandDefinition[] {
    return [...this.commands.values()];
  }

  allowedCommands(type: string, event: string): readonly CommandDefinition[] {
    const definition = this.components.get(type);
    if (!definition?.events.includes(event)) return [];
    const allowed = definition.eventCommands?.[event];
    if (!allowed) return [...this.commands.values()];
    return allowed
      .map((id) => this.commands.get(id))
      .filter((command): command is CommandDefinition => Boolean(command));
  }

  canBind(type: string, event: string, commandId: string): boolean {
    return this.allowedCommands(type, event).some((command) => command.id === commandId);
  }

  validateComponent(instance: UiComponentInstance): string[] {
    const errors: string[] = [];
    const definition = this.components.get(instance.type);
    if (!definition) return [`unknown component type: ${instance.type}`];
    if (definition.moduleId !== instance.moduleId) {
      errors.push(
        `component ${instance.id} belongs to ${definition.moduleId}, not ${instance.moduleId}`,
      );
    }
    if (!definition.slots.includes(instance.slot)) {
      errors.push(`component ${instance.id} cannot render in slot ${instance.slot}`);
    }
    if (!Number.isInteger(instance.order) || instance.order < 0) {
      errors.push(`component ${instance.id} order must be a non-negative integer`);
    }
    if (!Number.isInteger(instance.grid.columnSpan) || instance.grid.columnSpan < 1 || instance.grid.columnSpan > 12) {
      errors.push(`component ${instance.id} columnSpan must be an integer from 1 to 12`);
    } else if (
      definition.columnSpans &&
      !definition.columnSpans.includes(instance.grid.columnSpan)
    ) {
      errors.push(`component ${instance.id} does not allow columnSpan ${instance.grid.columnSpan}`);
    }
    if (!Number.isInteger(instance.grid.rowSpan) || instance.grid.rowSpan < 1 || instance.grid.rowSpan > 12) {
      errors.push(`component ${instance.id} rowSpan must be an integer from 1 to 12`);
    } else if (
      definition.rowSpans &&
      !definition.rowSpans.includes(instance.grid.rowSpan)
    ) {
      errors.push(`component ${instance.id} does not allow rowSpan ${instance.grid.rowSpan}`);
    }
    for (const [event, commandId] of Object.entries(instance.actions)) {
      if (!definition.events.includes(event)) {
        errors.push(`component ${instance.id} has unknown event ${event}`);
      }
      if (!this.commands.has(commandId)) {
        errors.push(`component ${instance.id} binds unknown command ${commandId}`);
      } else if (
        definition.eventCommands?.[event] &&
        !definition.eventCommands[event].includes(commandId)
      ) {
        errors.push(
          `component ${instance.id} cannot bind command ${commandId} to event ${event}`,
        );
      }
    }
    errors.push(...(definition.validateProps?.(instance.props) ?? []));
    return errors;
  }

  validateDocument(document: UiSurfaceDocumentV2): string[] {
    const errors: string[] = [];
    if (document.schemaVersion !== 2) errors.push("unsupported UI document schema");
    if (!document.id.trim()) errors.push("document id must not be empty");
    if (!Number.isInteger(document.revision) || document.revision < 0) {
      errors.push("document revision must be a non-negative integer");
    }
    const seen = new Set<string>();
    for (const component of document.components) {
      if (!component.id.trim()) errors.push("component id must not be empty");
      if (seen.has(component.id)) errors.push(`duplicate component id: ${component.id}`);
      seen.add(component.id);
      errors.push(...this.validateComponent(component));
    }
    return errors;
  }
}

function registerUnique<T>(
  map: Map<string, T>,
  key: string,
  value: T,
  label: string,
): () => void {
  if (!key.trim()) throw new Error(`${label} id must not be empty`);
  if (map.has(key)) throw new Error(`duplicate ${label}: ${key}`);
  map.set(key, value);
  let active = true;
  return () => {
    if (!active) return;
    active = false;
    if (map.get(key) === value) map.delete(key);
  };
}

function freeze<T extends object>(value: T): T {
  return Object.freeze(value);
}
