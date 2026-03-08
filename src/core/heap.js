/**
 * @module core/heap
 * @description Lightweight Min-Heap implementation for O(N log K) top-K selection.
 * 
 * Used for efficient RAG chunk ranking - instead of sorting N items O(N log N),
 * we maintain only K items in the heap O(N log K).
 */

/**
 * Min-Heap class for priority queue operations
 * @template T
 */
export class MinHeap {
    /**
     * @param {Function} [compareFn] - Optional comparison function (a, b) => -1/0/1
     */
    constructor(compareFn = null) {
        this.heap = [];
        this.compareFn = compareFn || ((a, b) => a - b);
    }

    /**
     * Get heap size
     * @returns {number}
     */
    get size() {
        return this.heap.length;
    }

    /**
     * Check if heap is empty
     * @returns {boolean}
     */
    isEmpty() {
        return this.heap.length === 0;
    }

    /**
     * Get parent index
     * @private
     */
    _parent(i) {
        return Math.floor((i - 1) / 2);
    }

    /**
     * Get left child index
     * @private
     */
    _left(i) {
        return 2 * i + 1;
    }

    /**
     * Get right child index
     * @private
     */
    _right(i) {
        return 2 * i + 2;
    }

    /**
     * Swap two elements
     * @private
     */
    _swap(i, j) {
        [this.heap[i], this.heap[j]] = [this.heap[j], this.heap[i]];
    }

    /**
     * Heapify up - restore heap property going up
     * @private
     */
    _heapifyUp(i) {
        while (i > 0) {
            const parent = this._parent(i);
            if (this.compareFn(this.heap[parent], this.heap[i]) > 0) {
                this._swap(i, parent);
                i = parent;
            } else {
                break;
            }
        }
    }

    /**
     * Heapify down - restore heap property going down
     * @private
     */
    _heapifyDown(i) {
        const length = this.heap.length;
        
        while (this._left(i) < length) {
            let smallest = i;
            const left = this._left(i);
            const right = this._right(i);
            
            if (this.compareFn(this.heap[left], this.heap[smallest]) < 0) {
                smallest = left;
            }
            
            if (right < length && this.compareFn(this.heap[right], this.heap[smallest]) < 0) {
                smallest = right;
            }
            
            if (smallest !== i) {
                this._swap(i, smallest);
                i = smallest;
            } else {
                break;
            }
        }
    }

    /**
     * Insert element into heap
     * @param {T} item
     */
    push(item) {
        this.heap.push(item);
        this._heapifyUp(this.heap.length - 1);
    }

    /**
     * Extract minimum element
     * @returns {T|undefined}
     */
    pop() {
        if (this.heap.length === 0) {
            return undefined;
        }
        
        const min = this.heap[0];
        const last = this.heap.pop();
        
        if (this.heap.length > 0) {
            this.heap[0] = last;
            this._heapifyDown(0);
        }
        
        return min;
    }

    /**
     * Peek at minimum element without removing
     * @returns {T|undefined}
     */
    peek() {
        return this.heap[0];
    }

    /**
     * Clear the heap
     */
    clear() {
        this.heap = [];
    }

    /**
     * Get all elements sorted (creates new array)
     * @returns {T[]}
     */
    toSortedArray() {
        const sorted = [...this.heap];
        sorted.sort(this.compareFn);
        return sorted;
    }
}

/**
 * Get top K items from an array in O(N log K) time.
 * More efficient than full sort O(N log N) when K << N.
 * 
 * @template T
 * @param {T[]} items - Array of items to rank
 * @param {number} k - Number of top items to return
 * @param {Function} scoreFn - Function to extract score from item (higher = better)
 * @returns {T[]} Top K items sorted by score (descending)
 */
export function getTopK(items, k, scoreFn) {
    if (!items || items.length === 0) return [];
    if (k <= 0) return [];
    if (items.length <= k) {
        // If fewer items than k, just sort and return
        return [...items].sort((a, b) => scoreFn(b) - scoreFn(a));
    }
    
    // Use min-heap to maintain top K efficiently
    const heap = new MinHeap((a, b) => scoreFn(a) - scoreFn(b));
    
    for (const item of items) {
        if (heap.size < k) {
            heap.push(item);
        } else if (scoreFn(item) > scoreFn(heap.peek())) {
            heap.pop();
            heap.push(item);
        }
    }
    
    // Extract and sort descending
    const result = [];
    let item;
    while ((item = heap.pop()) !== undefined) {
        result.unshift(item); // Add to front (will be reversed)
    }
    
    return result.sort((a, b) => scoreFn(b) - scoreFn(a));
}

/**
 * Specialized heap for RAG chunk similarity ranking.
 * Maintains top-K chunks by cosine similarity score.
 */
export class TopKChunks {
    /**
     * @param {number} k - Number of top chunks to keep
     */
    constructor(k = 5) {
        this.k = k;
        this.heap = new MinHeap((a, b) => a.sim - b.sim);
    }

    /**
     * Add a chunk with its similarity score
     * @param {Object} chunk - { text, sim, ... }
     */
    add(chunk) {
        if (this.heap.size < this.k) {
            this.heap.push(chunk);
        } else if (chunk.sim > this.heap.peek().sim) {
            this.heap.pop();
            this.heap.push(chunk);
        }
    }

    /**
     * Get top K chunks sorted by similarity (descending)
     * @returns {Object[]}
     */
    getTop() {
        const chunks = [];
        let chunk;
        while ((chunk = this.heap.pop()) !== undefined) {
            chunks.unshift(chunk);
        }
        return chunks.sort((a, b) => b.sim - a.sim);
    }

    /**
     * Check if heap has items
     * @returns {boolean}
     */
    isEmpty() {
        return this.heap.isEmpty();
    }

    /**
     * Get count of items in heap
     * @returns {number}
     */
    get count() {
        return this.heap.size;
    }
}
