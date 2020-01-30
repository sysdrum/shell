/// A generational entity ID
///
/// Solves the ABA problem by tagging indexes with generations. The generation is used to
/// determine if an entity is the same entity as the one which previously owned an
/// assigned component at a given index.
///
/// # Implementation Notes
///
/// - The first 32-bit integer is the index.
/// - The second 32-bit integer is the generation.
const Entity = new Uint32Array(2);

function entity_eq(a, b) {
    return a[0] == b[0] && b[1] == b[1];
}

function entity_new(pos, gen) {
    let entity = new Uint32Array(Entity);
    entity[0] = pos;
    entity[1] = gen;
    return entity;
}

/// Storages hold components of a specific type, and define these associations on entities
///
/// # Implementation Notes
///
/// Consists of an `Array` which uses the entity ID as the index into that array. Each
/// value in the array is an array which contains the entity's generation, and the
/// component which was assigned to it. The generation is used to determine if an
/// assigned component is stale on component lookup.
var Storage = class Storage {
    constructor() {
        this._store = new Array();
    }

    /// Private method for iterating across allocated slots
    * _iter() {
        let idx = 0;
        for (const slot of this._store) {
            if (slot) yield [idx, slot];
            idx += 1;
        }
    }

    /// Iterates across each stored component, and their entities
    * iter() {
        for (const [idx, [gen, value]] of this._iter()) {
            yield [entity_new(idx, gen), value];
        }
    }

    /// Iterates across each stored component
    * iter_values() {
        for (const [_idx, [_gen, value]] of this._iter()) {
            yield value;
        }
    }

    /// Finds values with the matching component
    * find(func) {
        for (const [idx, [gen, value]] of this._iter()) {
            if (func(value)) yield entity_new(idx, gen);
        }
    }

    /**
     * Checks if the component associated with this entity exists
     *
     * @param {Entity} entity
     */
    contains(entity) {
        return this.get(entity) != null;
    }

    /// Fetches the component for this entity, if it exists
    get(entity) {
        let [id, gen] = entity;
        const val = this._store[id];
        return (val && val[0] == gen) ? val[1] : null;
    }

    /// Fetches the component, and initializing it if it is missing
    get_or(entity, init) {
        let value = this.get(entity);

        if (!value) {
            value = init();
            if (!value) return null;
            this.insert(entity, value);
        }

        return value;
    }

    /// Assigns component to an entity
    insert(entity, component) {
        let [id, gen] = entity;

        let length = this._store.length;
        if (length >= id) {
            this._store.fill(null, length, id);
        }

        this._store[id] = [gen, component];
    }

    /// Removes the component for this entity, if it exists
    remove(entity) {
        const comp = this.get(entity);
        if (comp) {
            this._store[entity[0]] = null;
        };
        return comp;
    }

    /**
     * Takes the component associated with the `entity`, and passes it into the `func` callback
     *
     * @param {Entity} entity
     * @param {function} func
     */
    take_with(entity, func) {
        const component = this.remove(entity);
        return component ? func(component) : null;
    }

    /// Apply a function to the component when it exists
    with(entity, func) {
        const component = this.get(entity);
        return component ? func(component) : null
    }
}

/// The world maintains all of the entities, which have their components associated in storages
///
/// # Implementation Notes
///
/// This implementation consists of:
///
/// - An array for storing entities
/// - An array for storing a list of registered storages
/// - An array for containing a list of free slots to allocate
/// - An array for storing tags associated with an entity
var World = class World {
    constructor() {
        this._entities = new Array();
        this.storages = new Array();
        this._tags = new Array();
        this._free_slots = new Array();
    }

    /// The total capacity of the entity array
    get capacity() {
        return this._entities.length;
    }

    /// The number of unallocated entity slots
    get free() {
        return this._free_slots.length;
    }

    /// The number of allocated entities
    get length() {
        return this.capacity() - this.free();
    }

    /// Fetches tags associated with an entity
    ///
    /// Tags are essentially a dense set of small components
    tags(entity) {
        return this._tags[entity[0]];
    }

    /// Iterates across entities in the world
    * entities() {
        for (const entity in this._entities) {
            if (!this._free_slots.contains(entity[0])) yield entity;
        }
    }

    /// Create a new entity in the world
    ///
    /// Find the first available slot, and increment the generation.
    create_entity() {
        let slot = this._free_slots.pop();

        if (slot) {
            var entity = this._entities[slot];
            entity[1] += 1;
        } else {
            var entity = entity_new(this.capacity, 0);
            this._entities.push(entity);
            this._tags.push(new Set());
        }

        return entity;
    }

    /// Deletes an entity from the world
    ///
    /// Sets the `id` of the entity to `null`, thus marking its slot as unused.
    delete_entity(entity) {
        this.tags(entity).clear();
        for (const storage of this.storages) {
            storage.remove(entity);
        }

        this._free_slots.push(entity[0]);
    }

    /// Adds a new tag to the given entity
    add_tag(entity, tag) {
        this.tags(entity).add(tag);
    }

    /// Returns `true` if this tag exists for the given entity
    contains_tag(entity, tag) {
        return this.tags(entity).has(tag);
    }

    /// Deletes a tag from the given entity
    delete_tag(entity, tag) {
        this.tags(entity).delete(tag);
    }

    /// Registers a new component storage for our world
    ///
    /// This will be used to easily remove components when deleting an entity.
    register_storage() {
        let storage = new Storage();
        this.storages.push(storage);
        return storage;
    }
}
