(function(){function r(e,n,t){function o(i,f){if(!n[i]){if(!e[i]){var c="function"==typeof require&&require;if(!f&&c)return c(i,!0);if(u)return u(i,!0);var a=new Error("Cannot find module '"+i+"'");throw a.code="MODULE_NOT_FOUND",a}var p=n[i]={exports:{}};e[i][0].call(p.exports,function(r){var n=e[i][1][r];return o(n||r)},p,p.exports,r,e,n,t)}return n[i].exports}for(var u="function"==typeof require&&require,i=0;i<t.length;i++)o(t[i]);return o}return r})()({1:[function(require,module,exports){
/**
 * Copyright (c) 2014-present, Facebook, Inc.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

var runtime = (function (exports) {
  "use strict";

  var Op = Object.prototype;
  var hasOwn = Op.hasOwnProperty;
  var undefined; // More compressible than void 0.
  var $Symbol = typeof Symbol === "function" ? Symbol : {};
  var iteratorSymbol = $Symbol.iterator || "@@iterator";
  var asyncIteratorSymbol = $Symbol.asyncIterator || "@@asyncIterator";
  var toStringTagSymbol = $Symbol.toStringTag || "@@toStringTag";

  function wrap(innerFn, outerFn, self, tryLocsList) {
    // If outerFn provided and outerFn.prototype is a Generator, then outerFn.prototype instanceof Generator.
    var protoGenerator = outerFn && outerFn.prototype instanceof Generator ? outerFn : Generator;
    var generator = Object.create(protoGenerator.prototype);
    var context = new Context(tryLocsList || []);

    // The ._invoke method unifies the implementations of the .next,
    // .throw, and .return methods.
    generator._invoke = makeInvokeMethod(innerFn, self, context);

    return generator;
  }
  exports.wrap = wrap;

  // Try/catch helper to minimize deoptimizations. Returns a completion
  // record like context.tryEntries[i].completion. This interface could
  // have been (and was previously) designed to take a closure to be
  // invoked without arguments, but in all the cases we care about we
  // already have an existing method we want to call, so there's no need
  // to create a new function object. We can even get away with assuming
  // the method takes exactly one argument, since that happens to be true
  // in every case, so we don't have to touch the arguments object. The
  // only additional allocation required is the completion record, which
  // has a stable shape and so hopefully should be cheap to allocate.
  function tryCatch(fn, obj, arg) {
    try {
      return { type: "normal", arg: fn.call(obj, arg) };
    } catch (err) {
      return { type: "throw", arg: err };
    }
  }

  var GenStateSuspendedStart = "suspendedStart";
  var GenStateSuspendedYield = "suspendedYield";
  var GenStateExecuting = "executing";
  var GenStateCompleted = "completed";

  // Returning this object from the innerFn has the same effect as
  // breaking out of the dispatch switch statement.
  var ContinueSentinel = {};

  // Dummy constructor functions that we use as the .constructor and
  // .constructor.prototype properties for functions that return Generator
  // objects. For full spec compliance, you may wish to configure your
  // minifier not to mangle the names of these two functions.
  function Generator() {}
  function GeneratorFunction() {}
  function GeneratorFunctionPrototype() {}

  // This is a polyfill for %IteratorPrototype% for environments that
  // don't natively support it.
  var IteratorPrototype = {};
  IteratorPrototype[iteratorSymbol] = function () {
    return this;
  };

  var getProto = Object.getPrototypeOf;
  var NativeIteratorPrototype = getProto && getProto(getProto(values([])));
  if (NativeIteratorPrototype &&
      NativeIteratorPrototype !== Op &&
      hasOwn.call(NativeIteratorPrototype, iteratorSymbol)) {
    // This environment has a native %IteratorPrototype%; use it instead
    // of the polyfill.
    IteratorPrototype = NativeIteratorPrototype;
  }

  var Gp = GeneratorFunctionPrototype.prototype =
    Generator.prototype = Object.create(IteratorPrototype);
  GeneratorFunction.prototype = Gp.constructor = GeneratorFunctionPrototype;
  GeneratorFunctionPrototype.constructor = GeneratorFunction;
  GeneratorFunctionPrototype[toStringTagSymbol] =
    GeneratorFunction.displayName = "GeneratorFunction";

  // Helper for defining the .next, .throw, and .return methods of the
  // Iterator interface in terms of a single ._invoke method.
  function defineIteratorMethods(prototype) {
    ["next", "throw", "return"].forEach(function(method) {
      prototype[method] = function(arg) {
        return this._invoke(method, arg);
      };
    });
  }

  exports.isGeneratorFunction = function(genFun) {
    var ctor = typeof genFun === "function" && genFun.constructor;
    return ctor
      ? ctor === GeneratorFunction ||
        // For the native GeneratorFunction constructor, the best we can
        // do is to check its .name property.
        (ctor.displayName || ctor.name) === "GeneratorFunction"
      : false;
  };

  exports.mark = function(genFun) {
    if (Object.setPrototypeOf) {
      Object.setPrototypeOf(genFun, GeneratorFunctionPrototype);
    } else {
      genFun.__proto__ = GeneratorFunctionPrototype;
      if (!(toStringTagSymbol in genFun)) {
        genFun[toStringTagSymbol] = "GeneratorFunction";
      }
    }
    genFun.prototype = Object.create(Gp);
    return genFun;
  };

  // Within the body of any async function, `await x` is transformed to
  // `yield regeneratorRuntime.awrap(x)`, so that the runtime can test
  // `hasOwn.call(value, "__await")` to determine if the yielded value is
  // meant to be awaited.
  exports.awrap = function(arg) {
    return { __await: arg };
  };

  function AsyncIterator(generator) {
    function invoke(method, arg, resolve, reject) {
      var record = tryCatch(generator[method], generator, arg);
      if (record.type === "throw") {
        reject(record.arg);
      } else {
        var result = record.arg;
        var value = result.value;
        if (value &&
            typeof value === "object" &&
            hasOwn.call(value, "__await")) {
          return Promise.resolve(value.__await).then(function(value) {
            invoke("next", value, resolve, reject);
          }, function(err) {
            invoke("throw", err, resolve, reject);
          });
        }

        return Promise.resolve(value).then(function(unwrapped) {
          // When a yielded Promise is resolved, its final value becomes
          // the .value of the Promise<{value,done}> result for the
          // current iteration.
          result.value = unwrapped;
          resolve(result);
        }, function(error) {
          // If a rejected Promise was yielded, throw the rejection back
          // into the async generator function so it can be handled there.
          return invoke("throw", error, resolve, reject);
        });
      }
    }

    var previousPromise;

    function enqueue(method, arg) {
      function callInvokeWithMethodAndArg() {
        return new Promise(function(resolve, reject) {
          invoke(method, arg, resolve, reject);
        });
      }

      return previousPromise =
        // If enqueue has been called before, then we want to wait until
        // all previous Promises have been resolved before calling invoke,
        // so that results are always delivered in the correct order. If
        // enqueue has not been called before, then it is important to
        // call invoke immediately, without waiting on a callback to fire,
        // so that the async generator function has the opportunity to do
        // any necessary setup in a predictable way. This predictability
        // is why the Promise constructor synchronously invokes its
        // executor callback, and why async functions synchronously
        // execute code before the first await. Since we implement simple
        // async functions in terms of async generators, it is especially
        // important to get this right, even though it requires care.
        previousPromise ? previousPromise.then(
          callInvokeWithMethodAndArg,
          // Avoid propagating failures to Promises returned by later
          // invocations of the iterator.
          callInvokeWithMethodAndArg
        ) : callInvokeWithMethodAndArg();
    }

    // Define the unified helper method that is used to implement .next,
    // .throw, and .return (see defineIteratorMethods).
    this._invoke = enqueue;
  }

  defineIteratorMethods(AsyncIterator.prototype);
  AsyncIterator.prototype[asyncIteratorSymbol] = function () {
    return this;
  };
  exports.AsyncIterator = AsyncIterator;

  // Note that simple async functions are implemented on top of
  // AsyncIterator objects; they just return a Promise for the value of
  // the final result produced by the iterator.
  exports.async = function(innerFn, outerFn, self, tryLocsList) {
    var iter = new AsyncIterator(
      wrap(innerFn, outerFn, self, tryLocsList)
    );

    return exports.isGeneratorFunction(outerFn)
      ? iter // If outerFn is a generator, return the full iterator.
      : iter.next().then(function(result) {
          return result.done ? result.value : iter.next();
        });
  };

  function makeInvokeMethod(innerFn, self, context) {
    var state = GenStateSuspendedStart;

    return function invoke(method, arg) {
      if (state === GenStateExecuting) {
        throw new Error("Generator is already running");
      }

      if (state === GenStateCompleted) {
        if (method === "throw") {
          throw arg;
        }

        // Be forgiving, per 25.3.3.3.3 of the spec:
        // https://people.mozilla.org/~jorendorff/es6-draft.html#sec-generatorresume
        return doneResult();
      }

      context.method = method;
      context.arg = arg;

      while (true) {
        var delegate = context.delegate;
        if (delegate) {
          var delegateResult = maybeInvokeDelegate(delegate, context);
          if (delegateResult) {
            if (delegateResult === ContinueSentinel) continue;
            return delegateResult;
          }
        }

        if (context.method === "next") {
          // Setting context._sent for legacy support of Babel's
          // function.sent implementation.
          context.sent = context._sent = context.arg;

        } else if (context.method === "throw") {
          if (state === GenStateSuspendedStart) {
            state = GenStateCompleted;
            throw context.arg;
          }

          context.dispatchException(context.arg);

        } else if (context.method === "return") {
          context.abrupt("return", context.arg);
        }

        state = GenStateExecuting;

        var record = tryCatch(innerFn, self, context);
        if (record.type === "normal") {
          // If an exception is thrown from innerFn, we leave state ===
          // GenStateExecuting and loop back for another invocation.
          state = context.done
            ? GenStateCompleted
            : GenStateSuspendedYield;

          if (record.arg === ContinueSentinel) {
            continue;
          }

          return {
            value: record.arg,
            done: context.done
          };

        } else if (record.type === "throw") {
          state = GenStateCompleted;
          // Dispatch the exception by looping back around to the
          // context.dispatchException(context.arg) call above.
          context.method = "throw";
          context.arg = record.arg;
        }
      }
    };
  }

  // Call delegate.iterator[context.method](context.arg) and handle the
  // result, either by returning a { value, done } result from the
  // delegate iterator, or by modifying context.method and context.arg,
  // setting context.delegate to null, and returning the ContinueSentinel.
  function maybeInvokeDelegate(delegate, context) {
    var method = delegate.iterator[context.method];
    if (method === undefined) {
      // A .throw or .return when the delegate iterator has no .throw
      // method always terminates the yield* loop.
      context.delegate = null;

      if (context.method === "throw") {
        // Note: ["return"] must be used for ES3 parsing compatibility.
        if (delegate.iterator["return"]) {
          // If the delegate iterator has a return method, give it a
          // chance to clean up.
          context.method = "return";
          context.arg = undefined;
          maybeInvokeDelegate(delegate, context);

          if (context.method === "throw") {
            // If maybeInvokeDelegate(context) changed context.method from
            // "return" to "throw", let that override the TypeError below.
            return ContinueSentinel;
          }
        }

        context.method = "throw";
        context.arg = new TypeError(
          "The iterator does not provide a 'throw' method");
      }

      return ContinueSentinel;
    }

    var record = tryCatch(method, delegate.iterator, context.arg);

    if (record.type === "throw") {
      context.method = "throw";
      context.arg = record.arg;
      context.delegate = null;
      return ContinueSentinel;
    }

    var info = record.arg;

    if (! info) {
      context.method = "throw";
      context.arg = new TypeError("iterator result is not an object");
      context.delegate = null;
      return ContinueSentinel;
    }

    if (info.done) {
      // Assign the result of the finished delegate to the temporary
      // variable specified by delegate.resultName (see delegateYield).
      context[delegate.resultName] = info.value;

      // Resume execution at the desired location (see delegateYield).
      context.next = delegate.nextLoc;

      // If context.method was "throw" but the delegate handled the
      // exception, let the outer generator proceed normally. If
      // context.method was "next", forget context.arg since it has been
      // "consumed" by the delegate iterator. If context.method was
      // "return", allow the original .return call to continue in the
      // outer generator.
      if (context.method !== "return") {
        context.method = "next";
        context.arg = undefined;
      }

    } else {
      // Re-yield the result returned by the delegate method.
      return info;
    }

    // The delegate iterator is finished, so forget it and continue with
    // the outer generator.
    context.delegate = null;
    return ContinueSentinel;
  }

  // Define Generator.prototype.{next,throw,return} in terms of the
  // unified ._invoke helper method.
  defineIteratorMethods(Gp);

  Gp[toStringTagSymbol] = "Generator";

  // A Generator should always return itself as the iterator object when the
  // @@iterator function is called on it. Some browsers' implementations of the
  // iterator prototype chain incorrectly implement this, causing the Generator
  // object to not be returned from this call. This ensures that doesn't happen.
  // See https://github.com/facebook/regenerator/issues/274 for more details.
  Gp[iteratorSymbol] = function() {
    return this;
  };

  Gp.toString = function() {
    return "[object Generator]";
  };

  function pushTryEntry(locs) {
    var entry = { tryLoc: locs[0] };

    if (1 in locs) {
      entry.catchLoc = locs[1];
    }

    if (2 in locs) {
      entry.finallyLoc = locs[2];
      entry.afterLoc = locs[3];
    }

    this.tryEntries.push(entry);
  }

  function resetTryEntry(entry) {
    var record = entry.completion || {};
    record.type = "normal";
    delete record.arg;
    entry.completion = record;
  }

  function Context(tryLocsList) {
    // The root entry object (effectively a try statement without a catch
    // or a finally block) gives us a place to store values thrown from
    // locations where there is no enclosing try statement.
    this.tryEntries = [{ tryLoc: "root" }];
    tryLocsList.forEach(pushTryEntry, this);
    this.reset(true);
  }

  exports.keys = function(object) {
    var keys = [];
    for (var key in object) {
      keys.push(key);
    }
    keys.reverse();

    // Rather than returning an object with a next method, we keep
    // things simple and return the next function itself.
    return function next() {
      while (keys.length) {
        var key = keys.pop();
        if (key in object) {
          next.value = key;
          next.done = false;
          return next;
        }
      }

      // To avoid creating an additional object, we just hang the .value
      // and .done properties off the next function object itself. This
      // also ensures that the minifier will not anonymize the function.
      next.done = true;
      return next;
    };
  };

  function values(iterable) {
    if (iterable) {
      var iteratorMethod = iterable[iteratorSymbol];
      if (iteratorMethod) {
        return iteratorMethod.call(iterable);
      }

      if (typeof iterable.next === "function") {
        return iterable;
      }

      if (!isNaN(iterable.length)) {
        var i = -1, next = function next() {
          while (++i < iterable.length) {
            if (hasOwn.call(iterable, i)) {
              next.value = iterable[i];
              next.done = false;
              return next;
            }
          }

          next.value = undefined;
          next.done = true;

          return next;
        };

        return next.next = next;
      }
    }

    // Return an iterator with no values.
    return { next: doneResult };
  }
  exports.values = values;

  function doneResult() {
    return { value: undefined, done: true };
  }

  Context.prototype = {
    constructor: Context,

    reset: function(skipTempReset) {
      this.prev = 0;
      this.next = 0;
      // Resetting context._sent for legacy support of Babel's
      // function.sent implementation.
      this.sent = this._sent = undefined;
      this.done = false;
      this.delegate = null;

      this.method = "next";
      this.arg = undefined;

      this.tryEntries.forEach(resetTryEntry);

      if (!skipTempReset) {
        for (var name in this) {
          // Not sure about the optimal order of these conditions:
          if (name.charAt(0) === "t" &&
              hasOwn.call(this, name) &&
              !isNaN(+name.slice(1))) {
            this[name] = undefined;
          }
        }
      }
    },

    stop: function() {
      this.done = true;

      var rootEntry = this.tryEntries[0];
      var rootRecord = rootEntry.completion;
      if (rootRecord.type === "throw") {
        throw rootRecord.arg;
      }

      return this.rval;
    },

    dispatchException: function(exception) {
      if (this.done) {
        throw exception;
      }

      var context = this;
      function handle(loc, caught) {
        record.type = "throw";
        record.arg = exception;
        context.next = loc;

        if (caught) {
          // If the dispatched exception was caught by a catch block,
          // then let that catch block handle the exception normally.
          context.method = "next";
          context.arg = undefined;
        }

        return !! caught;
      }

      for (var i = this.tryEntries.length - 1; i >= 0; --i) {
        var entry = this.tryEntries[i];
        var record = entry.completion;

        if (entry.tryLoc === "root") {
          // Exception thrown outside of any try block that could handle
          // it, so set the completion value of the entire function to
          // throw the exception.
          return handle("end");
        }

        if (entry.tryLoc <= this.prev) {
          var hasCatch = hasOwn.call(entry, "catchLoc");
          var hasFinally = hasOwn.call(entry, "finallyLoc");

          if (hasCatch && hasFinally) {
            if (this.prev < entry.catchLoc) {
              return handle(entry.catchLoc, true);
            } else if (this.prev < entry.finallyLoc) {
              return handle(entry.finallyLoc);
            }

          } else if (hasCatch) {
            if (this.prev < entry.catchLoc) {
              return handle(entry.catchLoc, true);
            }

          } else if (hasFinally) {
            if (this.prev < entry.finallyLoc) {
              return handle(entry.finallyLoc);
            }

          } else {
            throw new Error("try statement without catch or finally");
          }
        }
      }
    },

    abrupt: function(type, arg) {
      for (var i = this.tryEntries.length - 1; i >= 0; --i) {
        var entry = this.tryEntries[i];
        if (entry.tryLoc <= this.prev &&
            hasOwn.call(entry, "finallyLoc") &&
            this.prev < entry.finallyLoc) {
          var finallyEntry = entry;
          break;
        }
      }

      if (finallyEntry &&
          (type === "break" ||
           type === "continue") &&
          finallyEntry.tryLoc <= arg &&
          arg <= finallyEntry.finallyLoc) {
        // Ignore the finally entry if control is not jumping to a
        // location outside the try/catch block.
        finallyEntry = null;
      }

      var record = finallyEntry ? finallyEntry.completion : {};
      record.type = type;
      record.arg = arg;

      if (finallyEntry) {
        this.method = "next";
        this.next = finallyEntry.finallyLoc;
        return ContinueSentinel;
      }

      return this.complete(record);
    },

    complete: function(record, afterLoc) {
      if (record.type === "throw") {
        throw record.arg;
      }

      if (record.type === "break" ||
          record.type === "continue") {
        this.next = record.arg;
      } else if (record.type === "return") {
        this.rval = this.arg = record.arg;
        this.method = "return";
        this.next = "end";
      } else if (record.type === "normal" && afterLoc) {
        this.next = afterLoc;
      }

      return ContinueSentinel;
    },

    finish: function(finallyLoc) {
      for (var i = this.tryEntries.length - 1; i >= 0; --i) {
        var entry = this.tryEntries[i];
        if (entry.finallyLoc === finallyLoc) {
          this.complete(entry.completion, entry.afterLoc);
          resetTryEntry(entry);
          return ContinueSentinel;
        }
      }
    },

    "catch": function(tryLoc) {
      for (var i = this.tryEntries.length - 1; i >= 0; --i) {
        var entry = this.tryEntries[i];
        if (entry.tryLoc === tryLoc) {
          var record = entry.completion;
          if (record.type === "throw") {
            var thrown = record.arg;
            resetTryEntry(entry);
          }
          return thrown;
        }
      }

      // The context.catch method must only be called with a location
      // argument that corresponds to a known catch block.
      throw new Error("illegal catch attempt");
    },

    delegateYield: function(iterable, resultName, nextLoc) {
      this.delegate = {
        iterator: values(iterable),
        resultName: resultName,
        nextLoc: nextLoc
      };

      if (this.method === "next") {
        // Deliberately forget the last sent value so that we don't
        // accidentally pass it on to the delegate.
        this.arg = undefined;
      }

      return ContinueSentinel;
    }
  };

  // Regardless of whether this script is executing as a CommonJS module
  // or not, return the runtime object so that we can declare the variable
  // regeneratorRuntime in the outer scope, which allows this module to be
  // injected easily by `bin/regenerator --include-runtime script.js`.
  return exports;

}(
  // If this script is executing as a CommonJS module, use module.exports
  // as the regeneratorRuntime namespace. Otherwise create a new empty
  // object. Either way, the resulting object will be used to initialize
  // the regeneratorRuntime variable at the top of this file.
  typeof module === "object" ? module.exports : {}
));

try {
  regeneratorRuntime = runtime;
} catch (accidentalStrictMode) {
  // This module should not be running in strict mode, so the above
  // assignment should always work unless something is misconfigured. Just
  // in case runtime.js accidentally runs in strict mode, we can escape
  // strict mode using a global Function call. This could conceivably fail
  // if a Content Security Policy forbids using Function, but in that case
  // the proper solution is to fix the accidental strict mode problem. If
  // you've misconfigured your bundler to force strict mode and applied a
  // CSP to forbid Function, and you're not willing to fix either of those
  // problems, please detail your unique predicament in a GitHub issue.
  Function("r", "regeneratorRuntime = r")(runtime);
}

},{}],2:[function(require,module,exports){
"use strict";

function _toConsumableArray(arr) { return _arrayWithoutHoles(arr) || _iterableToArray(arr) || _nonIterableSpread(); }

function _nonIterableSpread() { throw new TypeError("Invalid attempt to spread non-iterable instance"); }

function _iterableToArray(iter) { if (Symbol.iterator in Object(iter) || Object.prototype.toString.call(iter) === "[object Arguments]") return Array.from(iter); }

function _arrayWithoutHoles(arr) { if (Array.isArray(arr)) { for (var i = 0, arr2 = new Array(arr.length); i < arr.length; i++) { arr2[i] = arr[i]; } return arr2; } }

var regeneratorRuntime = require("regenerator-runtime");

var topline = document.querySelector(".menu");
var mobileMenu = document.getElementById("mobileMenu");
var closeBtn = document.getElementById("closeBtn");
var burger = document.getElementById("burger");
var mobileList = document.getElementById("mobileList");
var seeMore = document.getElementById("seeMore");
var accordeon = document.getElementById("accordeon");
var readMore1 = document.getElementById("readMore1");
var readMore2 = document.getElementById("readMore2");
var readLess1 = document.getElementById("readLess1");
var readLess2 = document.getElementById("readLess2");
var listFirst = document.getElementById("listFirst");
var textFirst = document.getElementById("textFirst");
var textSecond = document.getElementById("textSecond");
var cards = document.getElementById("cards");
var cardActive = document.getElementById("cardActive");
var counter = 3;
var raiser = 3;
var products = [{
  src: "img/1. Indoor.jpg",
  subtitle: "Indoor energy services",
  text: "We helped Indoor energy services to greaty simplify their case management system..."
}, {
  src: "img/2. Birdie.jpg",
  subtitle: "Birdie Gold Tours",
  text: "We helped Birdy Golf Tours to stay releveant on an inclreasingly competitive market..."
}, {
  src: "img/3. NowWhere.jpg",
  subtitle: "NowWhere",
  text: "We built a recommendations app for people working in creative industries..."
}, {
  src: "img/4. Fyndiqsvajpen.jpg",
  subtitle: "Fyndiqsvajpen",
  text: "We created an app that helped customers find gifts among more than 2900000 items..."
}, {
  src: "img/5. Bythjul.jpg",
  subtitle: "Bythjul",
  text: "We created tire fashion for the increasingly egalitarian car maintinace market..."
}, {
  src: "img/6. Tickin.jpg",
  subtitle: "Tickin",
  text: "We invented a time reporting system for people who hate time tracking..."
}, {
  src: "img/7. Ubermeds.jpg",
  subtitle: "Ubermeds",
  text: "We created an app that helped customers find gifts among more than 2900000 items..."
}, {
  src: "img/8. Västtrafik Calculator.jpg",
  subtitle: "Västtrafik Calculator",
  text: "We created tire fashion for the increasingly egalitarian car maintinace market..."
}, {
  src: "img/9. Träningspartner.jpg",
  subtitle: "Träningspartner",
  text: "We invented a time reporting system for people who hate time tracking..."
}];
document.addEventListener("scroll", function () {
  if (window.pageYOffset < topline.clientHeight) {
    topline.classList.remove("fixed");
  } else {
    topline.classList.add("fixed");
  }
});

burger.onclick = function (e) {
  e.preventDefault();
  mobileMenu.classList.toggle("hide");
};

closeBtn.onclick = function (e) {
  e.preventDefault();
  mobileMenu.classList.toggle("hide");
};

mobileList.onclick = function () {
  mobileMenu.classList.toggle("hide");
};

accordeon.addEventListener("click", function (e) {
  var target = e.target;
  var list = document.getElementsByClassName("how-we-do__tablet-item");

  var arr = _toConsumableArray(list);

  if (target.classList.contains('show')) {
    target.classList.toggle("show");
  } else {
    arr.map(function (i) {
      return i.classList.remove("show");
    });
    target.classList.toggle("show");
  }
});
cards.addEventListener("mouseover", function (e) {
  var target = e.target;
  var childs = cards.children;

  if (target.classList.contains('methods__card')) {
    for (var i = 0, child; child = childs[i]; i++) {
      child.classList.remove('active');
    }

    target.classList.add('active');
  } else return;
});

readMore1.onclick = function () {
  listFirst.classList.toggle("more");
  textFirst.classList.toggle("more");
  readMore1.classList.toggle("hidden");
  readLess1.classList.toggle("hidden");
};

readLess1.onclick = function () {
  listFirst.classList.toggle("more");
  textFirst.classList.toggle("more");
  readMore1.classList.toggle("hidden");
  readLess1.classList.toggle("hidden");
};

readMore2.onclick = function () {
  textSecond.classList.toggle("more");
  readMore2.classList.toggle("hidden");
  readLess2.classList.toggle("hidden");
};

readLess2.onclick = function () {
  textSecond.classList.toggle("more");
  readMore2.classList.toggle("hidden");
  readLess2.classList.toggle("hidden");
};

var renderProducts = function renderProducts(item) {
  return "<div class=\"col-12 col-md-6 col-lg-4\">\n  <div class=\"projects__card\">\n    <div class=\"projects__img-wrapper\"><img src=\"".concat(item.src, "\" alt=\"mask\"></div>\n    <div class=\"projects__info\">\n      <h4 class=\"projects__subtitle\">").concat(item.subtitle, "</h4>\n      <p class=\"projects__text\">").concat(item.text, "</p>\n    </div>\n  </div>\n</div>");
};

var renderSection = function renderSection(projectsData) {
  var projects = projectsData.map(function (element) {
    return renderProducts(element);
  });
  document.getElementById("projectsRender").innerHTML = projects.join("");
};

seeMore.onclick = function (e) {
  e.preventDefault();
  counter += raiser;
  renderSection(products.slice(0, counter));
};

window.addEventListener("DOMContentLoaded", function () {
  var witdhCounter = function witdhCounter() {
    return regeneratorRuntime.async(function witdhCounter$(_context) {
      while (1) {
        switch (_context.prev = _context.next) {
          case 0:
            _context.t0 = true;
            _context.next = _context.t0 === document.documentElement.clientWidth > 768 ? 3 : _context.t0 === document.documentElement.clientWidth > 414 ? 5 : 8;
            break;

          case 3:
            counter = 9;
            return _context.abrupt("break", 11);

          case 5:
            counter = 4;
            raiser = 4;
            return _context.abrupt("break", 11);

          case 8:
            counter = 3;
            raiser = 3;
            return _context.abrupt("break", 11);

          case 11:
          case "end":
            return _context.stop();
        }
      }
    });
  };

  witdhCounter();
  renderSection(products.slice(0, counter));
});

},{"regenerator-runtime":1}]},{},[2])

//# sourceMappingURL=data:application/json;charset=utf8;base64,eyJ2ZXJzaW9uIjozLCJzb3VyY2VzIjpbIm5vZGVfbW9kdWxlcy9icm93c2VyLXBhY2svX3ByZWx1ZGUuanMiLCJub2RlX21vZHVsZXMvcmVnZW5lcmF0b3ItcnVudGltZS9ydW50aW1lLmpzIiwicHJvamVjdHMvd2hpdGVwb3J0LXNpdGUvc3JjL2pzL2FwcC5qcyJdLCJuYW1lcyI6W10sIm1hcHBpbmdzIjoiQUFBQTtBQ0FBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBOzs7Ozs7Ozs7Ozs7QUN0dEJBLElBQU0sa0JBQWtCLEdBQUcsT0FBTyxDQUFDLHFCQUFELENBQWxDOztBQUVBLElBQU0sT0FBTyxHQUFHLFFBQVEsQ0FBQyxhQUFULENBQXVCLE9BQXZCLENBQWhCO0FBQ0EsSUFBTSxVQUFVLEdBQUcsUUFBUSxDQUFDLGNBQVQsQ0FBd0IsWUFBeEIsQ0FBbkI7QUFDQSxJQUFNLFFBQVEsR0FBRyxRQUFRLENBQUMsY0FBVCxDQUF3QixVQUF4QixDQUFqQjtBQUNBLElBQU0sTUFBTSxHQUFHLFFBQVEsQ0FBQyxjQUFULENBQXdCLFFBQXhCLENBQWY7QUFDQSxJQUFNLFVBQVUsR0FBRyxRQUFRLENBQUMsY0FBVCxDQUF3QixZQUF4QixDQUFuQjtBQUNBLElBQU0sT0FBTyxHQUFHLFFBQVEsQ0FBQyxjQUFULENBQXdCLFNBQXhCLENBQWhCO0FBQ0EsSUFBTSxTQUFTLEdBQUcsUUFBUSxDQUFDLGNBQVQsQ0FBd0IsV0FBeEIsQ0FBbEI7QUFDQSxJQUFNLFNBQVMsR0FBRyxRQUFRLENBQUMsY0FBVCxDQUF3QixXQUF4QixDQUFsQjtBQUNBLElBQU0sU0FBUyxHQUFHLFFBQVEsQ0FBQyxjQUFULENBQXdCLFdBQXhCLENBQWxCO0FBQ0EsSUFBTSxTQUFTLEdBQUcsUUFBUSxDQUFDLGNBQVQsQ0FBd0IsV0FBeEIsQ0FBbEI7QUFDQSxJQUFNLFNBQVMsR0FBRyxRQUFRLENBQUMsY0FBVCxDQUF3QixXQUF4QixDQUFsQjtBQUNBLElBQU0sU0FBUyxHQUFHLFFBQVEsQ0FBQyxjQUFULENBQXdCLFdBQXhCLENBQWxCO0FBQ0EsSUFBTSxTQUFTLEdBQUcsUUFBUSxDQUFDLGNBQVQsQ0FBd0IsV0FBeEIsQ0FBbEI7QUFDQSxJQUFNLFVBQVUsR0FBRyxRQUFRLENBQUMsY0FBVCxDQUF3QixZQUF4QixDQUFuQjtBQUNBLElBQU0sS0FBSyxHQUFHLFFBQVEsQ0FBQyxjQUFULENBQXdCLE9BQXhCLENBQWQ7QUFDQSxJQUFNLFVBQVUsR0FBRyxRQUFRLENBQUMsY0FBVCxDQUF3QixZQUF4QixDQUFuQjtBQUNBLElBQUksT0FBTyxHQUFHLENBQWQ7QUFDQSxJQUFJLE1BQU0sR0FBRyxDQUFiO0FBQ0EsSUFBTSxRQUFRLEdBQUcsQ0FDZjtBQUNFLEVBQUEsR0FBRyxFQUFFLG1CQURQO0FBRUUsRUFBQSxRQUFRLEVBQUUsd0JBRlo7QUFHRSxFQUFBLElBQUksRUFDRjtBQUpKLENBRGUsRUFPZjtBQUNFLEVBQUEsR0FBRyxFQUFFLG1CQURQO0FBRUUsRUFBQSxRQUFRLEVBQUUsbUJBRlo7QUFHRSxFQUFBLElBQUksRUFDRjtBQUpKLENBUGUsRUFhZjtBQUNFLEVBQUEsR0FBRyxFQUFFLHFCQURQO0FBRUUsRUFBQSxRQUFRLEVBQUUsVUFGWjtBQUdFLEVBQUEsSUFBSSxFQUNGO0FBSkosQ0FiZSxFQW1CZjtBQUNFLEVBQUEsR0FBRyxFQUFFLDBCQURQO0FBRUUsRUFBQSxRQUFRLEVBQUUsZUFGWjtBQUdFLEVBQUEsSUFBSSxFQUNGO0FBSkosQ0FuQmUsRUF5QmY7QUFDRSxFQUFBLEdBQUcsRUFBRSxvQkFEUDtBQUVFLEVBQUEsUUFBUSxFQUFFLFNBRlo7QUFHRSxFQUFBLElBQUksRUFDRjtBQUpKLENBekJlLEVBK0JmO0FBQ0UsRUFBQSxHQUFHLEVBQUUsbUJBRFA7QUFFRSxFQUFBLFFBQVEsRUFBRSxRQUZaO0FBR0UsRUFBQSxJQUFJLEVBQ0Y7QUFKSixDQS9CZSxFQXFDZjtBQUNFLEVBQUEsR0FBRyxFQUFFLHFCQURQO0FBRUUsRUFBQSxRQUFRLEVBQUUsVUFGWjtBQUdFLEVBQUEsSUFBSSxFQUNGO0FBSkosQ0FyQ2UsRUEyQ2Y7QUFDRSxFQUFBLEdBQUcsRUFBRSxrQ0FEUDtBQUVFLEVBQUEsUUFBUSxFQUFFLHVCQUZaO0FBR0UsRUFBQSxJQUFJLEVBQ0Y7QUFKSixDQTNDZSxFQWlEZjtBQUNFLEVBQUEsR0FBRyxFQUFFLDRCQURQO0FBRUUsRUFBQSxRQUFRLEVBQUUsaUJBRlo7QUFHRSxFQUFBLElBQUksRUFDRjtBQUpKLENBakRlLENBQWpCO0FBeURBLFFBQVEsQ0FBQyxnQkFBVCxDQUEwQixRQUExQixFQUFvQyxZQUFNO0FBQ3hDLE1BQUksTUFBTSxDQUFDLFdBQVAsR0FBcUIsT0FBTyxDQUFDLFlBQWpDLEVBQStDO0FBQzdDLElBQUEsT0FBTyxDQUFDLFNBQVIsQ0FBa0IsTUFBbEIsQ0FBeUIsT0FBekI7QUFDRCxHQUZELE1BRU87QUFDTCxJQUFBLE9BQU8sQ0FBQyxTQUFSLENBQWtCLEdBQWxCLENBQXNCLE9BQXRCO0FBQ0Q7QUFDRixDQU5EOztBQVFBLE1BQU0sQ0FBQyxPQUFQLEdBQWlCLFVBQUEsQ0FBQyxFQUFJO0FBQ3BCLEVBQUEsQ0FBQyxDQUFDLGNBQUY7QUFDQSxFQUFBLFVBQVUsQ0FBQyxTQUFYLENBQXFCLE1BQXJCLENBQTRCLE1BQTVCO0FBQ0QsQ0FIRDs7QUFLQSxRQUFRLENBQUMsT0FBVCxHQUFtQixVQUFBLENBQUMsRUFBSTtBQUN0QixFQUFBLENBQUMsQ0FBQyxjQUFGO0FBQ0EsRUFBQSxVQUFVLENBQUMsU0FBWCxDQUFxQixNQUFyQixDQUE0QixNQUE1QjtBQUNELENBSEQ7O0FBS0EsVUFBVSxDQUFDLE9BQVgsR0FBcUIsWUFBTTtBQUN6QixFQUFBLFVBQVUsQ0FBQyxTQUFYLENBQXFCLE1BQXJCLENBQTRCLE1BQTVCO0FBQ0QsQ0FGRDs7QUFJQSxTQUFTLENBQUMsZ0JBQVYsQ0FBMkIsT0FBM0IsRUFBb0MsVUFBQSxDQUFDLEVBQUk7QUFDdkMsTUFBSSxNQUFNLEdBQUcsQ0FBQyxDQUFDLE1BQWY7QUFDQSxNQUFNLElBQUksR0FBRyxRQUFRLENBQUMsc0JBQVQsQ0FBZ0Msd0JBQWhDLENBQWI7O0FBQ0EsTUFBSSxHQUFHLHNCQUFPLElBQVAsQ0FBUDs7QUFDQSxNQUFJLE1BQU0sQ0FBQyxTQUFQLENBQWlCLFFBQWpCLENBQTBCLE1BQTFCLENBQUosRUFBdUM7QUFDckMsSUFBQSxNQUFNLENBQUMsU0FBUCxDQUFpQixNQUFqQixDQUF3QixNQUF4QjtBQUNELEdBRkQsTUFFTztBQUNMLElBQUEsR0FBRyxDQUFDLEdBQUosQ0FBUSxVQUFBLENBQUM7QUFBQSxhQUFJLENBQUMsQ0FBQyxTQUFGLENBQVksTUFBWixDQUFtQixNQUFuQixDQUFKO0FBQUEsS0FBVDtBQUNBLElBQUEsTUFBTSxDQUFDLFNBQVAsQ0FBaUIsTUFBakIsQ0FBd0IsTUFBeEI7QUFDRDtBQUNGLENBVkQ7QUFZQSxLQUFLLENBQUMsZ0JBQU4sQ0FBdUIsV0FBdkIsRUFBb0MsVUFBQSxDQUFDLEVBQUk7QUFDdkMsTUFBTSxNQUFNLEdBQUcsQ0FBQyxDQUFDLE1BQWpCO0FBQ0EsTUFBTSxNQUFNLEdBQUcsS0FBSyxDQUFDLFFBQXJCOztBQUNBLE1BQUcsTUFBTSxDQUFDLFNBQVAsQ0FBaUIsUUFBakIsQ0FBMEIsZUFBMUIsQ0FBSCxFQUErQztBQUM3QyxTQUFLLElBQUksQ0FBQyxHQUFDLENBQU4sRUFBUyxLQUFkLEVBQXFCLEtBQUssR0FBRyxNQUFNLENBQUMsQ0FBRCxDQUFuQyxFQUF3QyxDQUFDLEVBQXpDLEVBQTZDO0FBQzNDLE1BQUEsS0FBSyxDQUFDLFNBQU4sQ0FBZ0IsTUFBaEIsQ0FBdUIsUUFBdkI7QUFDRDs7QUFDRCxJQUFBLE1BQU0sQ0FBQyxTQUFQLENBQWlCLEdBQWpCLENBQXFCLFFBQXJCO0FBQ0QsR0FMRCxNQUtPO0FBQ1IsQ0FURDs7QUFXQSxTQUFTLENBQUMsT0FBVixHQUFvQixZQUFNO0FBQ3hCLEVBQUEsU0FBUyxDQUFDLFNBQVYsQ0FBb0IsTUFBcEIsQ0FBMkIsTUFBM0I7QUFDQSxFQUFBLFNBQVMsQ0FBQyxTQUFWLENBQW9CLE1BQXBCLENBQTJCLE1BQTNCO0FBQ0EsRUFBQSxTQUFTLENBQUMsU0FBVixDQUFvQixNQUFwQixDQUEyQixRQUEzQjtBQUNBLEVBQUEsU0FBUyxDQUFDLFNBQVYsQ0FBb0IsTUFBcEIsQ0FBMkIsUUFBM0I7QUFDRCxDQUxEOztBQU9BLFNBQVMsQ0FBQyxPQUFWLEdBQW9CLFlBQU07QUFDeEIsRUFBQSxTQUFTLENBQUMsU0FBVixDQUFvQixNQUFwQixDQUEyQixNQUEzQjtBQUNBLEVBQUEsU0FBUyxDQUFDLFNBQVYsQ0FBb0IsTUFBcEIsQ0FBMkIsTUFBM0I7QUFDQSxFQUFBLFNBQVMsQ0FBQyxTQUFWLENBQW9CLE1BQXBCLENBQTJCLFFBQTNCO0FBQ0EsRUFBQSxTQUFTLENBQUMsU0FBVixDQUFvQixNQUFwQixDQUEyQixRQUEzQjtBQUNELENBTEQ7O0FBT0EsU0FBUyxDQUFDLE9BQVYsR0FBb0IsWUFBTTtBQUN4QixFQUFBLFVBQVUsQ0FBQyxTQUFYLENBQXFCLE1BQXJCLENBQTRCLE1BQTVCO0FBQ0EsRUFBQSxTQUFTLENBQUMsU0FBVixDQUFvQixNQUFwQixDQUEyQixRQUEzQjtBQUNBLEVBQUEsU0FBUyxDQUFDLFNBQVYsQ0FBb0IsTUFBcEIsQ0FBMkIsUUFBM0I7QUFDRCxDQUpEOztBQU1BLFNBQVMsQ0FBQyxPQUFWLEdBQW9CLFlBQU07QUFDeEIsRUFBQSxVQUFVLENBQUMsU0FBWCxDQUFxQixNQUFyQixDQUE0QixNQUE1QjtBQUNBLEVBQUEsU0FBUyxDQUFDLFNBQVYsQ0FBb0IsTUFBcEIsQ0FBMkIsUUFBM0I7QUFDQSxFQUFBLFNBQVMsQ0FBQyxTQUFWLENBQW9CLE1BQXBCLENBQTJCLFFBQTNCO0FBQ0QsQ0FKRDs7QUFNQSxJQUFNLGNBQWMsR0FBRyxTQUFqQixjQUFpQixDQUFBLElBQUksRUFBSTtBQUM3QixtSkFFaUQsSUFBSSxDQUFDLEdBRnRELGdIQUlxQyxJQUFJLENBQUMsUUFKMUMsc0RBS2dDLElBQUksQ0FBQyxJQUxyQztBQVNELENBVkQ7O0FBWUEsSUFBSSxhQUFhLEdBQUcsU0FBaEIsYUFBZ0IsQ0FBQSxZQUFZLEVBQUk7QUFDbEMsTUFBTSxRQUFRLEdBQUcsWUFBWSxDQUFDLEdBQWIsQ0FBaUIsVUFBQSxPQUFPO0FBQUEsV0FBSSxjQUFjLENBQUMsT0FBRCxDQUFsQjtBQUFBLEdBQXhCLENBQWpCO0FBQ0EsRUFBQSxRQUFRLENBQUMsY0FBVCxDQUF3QixnQkFBeEIsRUFBMEMsU0FBMUMsR0FBc0QsUUFBUSxDQUFDLElBQVQsQ0FBYyxFQUFkLENBQXREO0FBQ0QsQ0FIRDs7QUFLQSxPQUFPLENBQUMsT0FBUixHQUFrQixVQUFBLENBQUMsRUFBSTtBQUNyQixFQUFBLENBQUMsQ0FBQyxjQUFGO0FBQ0EsRUFBQSxPQUFPLElBQUksTUFBWDtBQUNBLEVBQUEsYUFBYSxDQUFDLFFBQVEsQ0FBQyxLQUFULENBQWUsQ0FBZixFQUFrQixPQUFsQixDQUFELENBQWI7QUFDRCxDQUpEOztBQU1BLE1BQU0sQ0FBQyxnQkFBUCxDQUF3QixrQkFBeEIsRUFBNEMsWUFBTTtBQUNoRCxNQUFNLFlBQVksR0FBRyxTQUFmLFlBQWU7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBLDBCQUNYLElBRFc7QUFBQSw0Q0FFWixRQUFRLENBQUMsZUFBVCxDQUF5QixXQUF6QixHQUF1QyxHQUYzQix1QkFLWixRQUFRLENBQUMsZUFBVCxDQUF5QixXQUF6QixHQUF1QyxHQUwzQjtBQUFBOztBQUFBO0FBR2YsWUFBQSxPQUFPLEdBQUcsQ0FBVjtBQUhlOztBQUFBO0FBTWYsWUFBQSxPQUFPLEdBQUcsQ0FBVjtBQUNBLFlBQUEsTUFBTSxHQUFHLENBQVQ7QUFQZTs7QUFBQTtBQVVmLFlBQUEsT0FBTyxHQUFHLENBQVY7QUFDQSxZQUFBLE1BQU0sR0FBRyxDQUFUO0FBWGU7O0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUEsR0FBckI7O0FBZUEsRUFBQSxZQUFZO0FBQ1osRUFBQSxhQUFhLENBQUMsUUFBUSxDQUFDLEtBQVQsQ0FBZSxDQUFmLEVBQWtCLE9BQWxCLENBQUQsQ0FBYjtBQUNELENBbEJEIiwiZmlsZSI6ImJ1bmRsZS5qcyIsInNvdXJjZXNDb250ZW50IjpbIihmdW5jdGlvbigpe2Z1bmN0aW9uIHIoZSxuLHQpe2Z1bmN0aW9uIG8oaSxmKXtpZighbltpXSl7aWYoIWVbaV0pe3ZhciBjPVwiZnVuY3Rpb25cIj09dHlwZW9mIHJlcXVpcmUmJnJlcXVpcmU7aWYoIWYmJmMpcmV0dXJuIGMoaSwhMCk7aWYodSlyZXR1cm4gdShpLCEwKTt2YXIgYT1uZXcgRXJyb3IoXCJDYW5ub3QgZmluZCBtb2R1bGUgJ1wiK2krXCInXCIpO3Rocm93IGEuY29kZT1cIk1PRFVMRV9OT1RfRk9VTkRcIixhfXZhciBwPW5baV09e2V4cG9ydHM6e319O2VbaV1bMF0uY2FsbChwLmV4cG9ydHMsZnVuY3Rpb24ocil7dmFyIG49ZVtpXVsxXVtyXTtyZXR1cm4gbyhufHxyKX0scCxwLmV4cG9ydHMscixlLG4sdCl9cmV0dXJuIG5baV0uZXhwb3J0c31mb3IodmFyIHU9XCJmdW5jdGlvblwiPT10eXBlb2YgcmVxdWlyZSYmcmVxdWlyZSxpPTA7aTx0Lmxlbmd0aDtpKyspbyh0W2ldKTtyZXR1cm4gb31yZXR1cm4gcn0pKCkiLCIvKipcbiAqIENvcHlyaWdodCAoYykgMjAxNC1wcmVzZW50LCBGYWNlYm9vaywgSW5jLlxuICpcbiAqIFRoaXMgc291cmNlIGNvZGUgaXMgbGljZW5zZWQgdW5kZXIgdGhlIE1JVCBsaWNlbnNlIGZvdW5kIGluIHRoZVxuICogTElDRU5TRSBmaWxlIGluIHRoZSByb290IGRpcmVjdG9yeSBvZiB0aGlzIHNvdXJjZSB0cmVlLlxuICovXG5cbnZhciBydW50aW1lID0gKGZ1bmN0aW9uIChleHBvcnRzKSB7XG4gIFwidXNlIHN0cmljdFwiO1xuXG4gIHZhciBPcCA9IE9iamVjdC5wcm90b3R5cGU7XG4gIHZhciBoYXNPd24gPSBPcC5oYXNPd25Qcm9wZXJ0eTtcbiAgdmFyIHVuZGVmaW5lZDsgLy8gTW9yZSBjb21wcmVzc2libGUgdGhhbiB2b2lkIDAuXG4gIHZhciAkU3ltYm9sID0gdHlwZW9mIFN5bWJvbCA9PT0gXCJmdW5jdGlvblwiID8gU3ltYm9sIDoge307XG4gIHZhciBpdGVyYXRvclN5bWJvbCA9ICRTeW1ib2wuaXRlcmF0b3IgfHwgXCJAQGl0ZXJhdG9yXCI7XG4gIHZhciBhc3luY0l0ZXJhdG9yU3ltYm9sID0gJFN5bWJvbC5hc3luY0l0ZXJhdG9yIHx8IFwiQEBhc3luY0l0ZXJhdG9yXCI7XG4gIHZhciB0b1N0cmluZ1RhZ1N5bWJvbCA9ICRTeW1ib2wudG9TdHJpbmdUYWcgfHwgXCJAQHRvU3RyaW5nVGFnXCI7XG5cbiAgZnVuY3Rpb24gd3JhcChpbm5lckZuLCBvdXRlckZuLCBzZWxmLCB0cnlMb2NzTGlzdCkge1xuICAgIC8vIElmIG91dGVyRm4gcHJvdmlkZWQgYW5kIG91dGVyRm4ucHJvdG90eXBlIGlzIGEgR2VuZXJhdG9yLCB0aGVuIG91dGVyRm4ucHJvdG90eXBlIGluc3RhbmNlb2YgR2VuZXJhdG9yLlxuICAgIHZhciBwcm90b0dlbmVyYXRvciA9IG91dGVyRm4gJiYgb3V0ZXJGbi5wcm90b3R5cGUgaW5zdGFuY2VvZiBHZW5lcmF0b3IgPyBvdXRlckZuIDogR2VuZXJhdG9yO1xuICAgIHZhciBnZW5lcmF0b3IgPSBPYmplY3QuY3JlYXRlKHByb3RvR2VuZXJhdG9yLnByb3RvdHlwZSk7XG4gICAgdmFyIGNvbnRleHQgPSBuZXcgQ29udGV4dCh0cnlMb2NzTGlzdCB8fCBbXSk7XG5cbiAgICAvLyBUaGUgLl9pbnZva2UgbWV0aG9kIHVuaWZpZXMgdGhlIGltcGxlbWVudGF0aW9ucyBvZiB0aGUgLm5leHQsXG4gICAgLy8gLnRocm93LCBhbmQgLnJldHVybiBtZXRob2RzLlxuICAgIGdlbmVyYXRvci5faW52b2tlID0gbWFrZUludm9rZU1ldGhvZChpbm5lckZuLCBzZWxmLCBjb250ZXh0KTtcblxuICAgIHJldHVybiBnZW5lcmF0b3I7XG4gIH1cbiAgZXhwb3J0cy53cmFwID0gd3JhcDtcblxuICAvLyBUcnkvY2F0Y2ggaGVscGVyIHRvIG1pbmltaXplIGRlb3B0aW1pemF0aW9ucy4gUmV0dXJucyBhIGNvbXBsZXRpb25cbiAgLy8gcmVjb3JkIGxpa2UgY29udGV4dC50cnlFbnRyaWVzW2ldLmNvbXBsZXRpb24uIFRoaXMgaW50ZXJmYWNlIGNvdWxkXG4gIC8vIGhhdmUgYmVlbiAoYW5kIHdhcyBwcmV2aW91c2x5KSBkZXNpZ25lZCB0byB0YWtlIGEgY2xvc3VyZSB0byBiZVxuICAvLyBpbnZva2VkIHdpdGhvdXQgYXJndW1lbnRzLCBidXQgaW4gYWxsIHRoZSBjYXNlcyB3ZSBjYXJlIGFib3V0IHdlXG4gIC8vIGFscmVhZHkgaGF2ZSBhbiBleGlzdGluZyBtZXRob2Qgd2Ugd2FudCB0byBjYWxsLCBzbyB0aGVyZSdzIG5vIG5lZWRcbiAgLy8gdG8gY3JlYXRlIGEgbmV3IGZ1bmN0aW9uIG9iamVjdC4gV2UgY2FuIGV2ZW4gZ2V0IGF3YXkgd2l0aCBhc3N1bWluZ1xuICAvLyB0aGUgbWV0aG9kIHRha2VzIGV4YWN0bHkgb25lIGFyZ3VtZW50LCBzaW5jZSB0aGF0IGhhcHBlbnMgdG8gYmUgdHJ1ZVxuICAvLyBpbiBldmVyeSBjYXNlLCBzbyB3ZSBkb24ndCBoYXZlIHRvIHRvdWNoIHRoZSBhcmd1bWVudHMgb2JqZWN0LiBUaGVcbiAgLy8gb25seSBhZGRpdGlvbmFsIGFsbG9jYXRpb24gcmVxdWlyZWQgaXMgdGhlIGNvbXBsZXRpb24gcmVjb3JkLCB3aGljaFxuICAvLyBoYXMgYSBzdGFibGUgc2hhcGUgYW5kIHNvIGhvcGVmdWxseSBzaG91bGQgYmUgY2hlYXAgdG8gYWxsb2NhdGUuXG4gIGZ1bmN0aW9uIHRyeUNhdGNoKGZuLCBvYmosIGFyZykge1xuICAgIHRyeSB7XG4gICAgICByZXR1cm4geyB0eXBlOiBcIm5vcm1hbFwiLCBhcmc6IGZuLmNhbGwob2JqLCBhcmcpIH07XG4gICAgfSBjYXRjaCAoZXJyKSB7XG4gICAgICByZXR1cm4geyB0eXBlOiBcInRocm93XCIsIGFyZzogZXJyIH07XG4gICAgfVxuICB9XG5cbiAgdmFyIEdlblN0YXRlU3VzcGVuZGVkU3RhcnQgPSBcInN1c3BlbmRlZFN0YXJ0XCI7XG4gIHZhciBHZW5TdGF0ZVN1c3BlbmRlZFlpZWxkID0gXCJzdXNwZW5kZWRZaWVsZFwiO1xuICB2YXIgR2VuU3RhdGVFeGVjdXRpbmcgPSBcImV4ZWN1dGluZ1wiO1xuICB2YXIgR2VuU3RhdGVDb21wbGV0ZWQgPSBcImNvbXBsZXRlZFwiO1xuXG4gIC8vIFJldHVybmluZyB0aGlzIG9iamVjdCBmcm9tIHRoZSBpbm5lckZuIGhhcyB0aGUgc2FtZSBlZmZlY3QgYXNcbiAgLy8gYnJlYWtpbmcgb3V0IG9mIHRoZSBkaXNwYXRjaCBzd2l0Y2ggc3RhdGVtZW50LlxuICB2YXIgQ29udGludWVTZW50aW5lbCA9IHt9O1xuXG4gIC8vIER1bW15IGNvbnN0cnVjdG9yIGZ1bmN0aW9ucyB0aGF0IHdlIHVzZSBhcyB0aGUgLmNvbnN0cnVjdG9yIGFuZFxuICAvLyAuY29uc3RydWN0b3IucHJvdG90eXBlIHByb3BlcnRpZXMgZm9yIGZ1bmN0aW9ucyB0aGF0IHJldHVybiBHZW5lcmF0b3JcbiAgLy8gb2JqZWN0cy4gRm9yIGZ1bGwgc3BlYyBjb21wbGlhbmNlLCB5b3UgbWF5IHdpc2ggdG8gY29uZmlndXJlIHlvdXJcbiAgLy8gbWluaWZpZXIgbm90IHRvIG1hbmdsZSB0aGUgbmFtZXMgb2YgdGhlc2UgdHdvIGZ1bmN0aW9ucy5cbiAgZnVuY3Rpb24gR2VuZXJhdG9yKCkge31cbiAgZnVuY3Rpb24gR2VuZXJhdG9yRnVuY3Rpb24oKSB7fVxuICBmdW5jdGlvbiBHZW5lcmF0b3JGdW5jdGlvblByb3RvdHlwZSgpIHt9XG5cbiAgLy8gVGhpcyBpcyBhIHBvbHlmaWxsIGZvciAlSXRlcmF0b3JQcm90b3R5cGUlIGZvciBlbnZpcm9ubWVudHMgdGhhdFxuICAvLyBkb24ndCBuYXRpdmVseSBzdXBwb3J0IGl0LlxuICB2YXIgSXRlcmF0b3JQcm90b3R5cGUgPSB7fTtcbiAgSXRlcmF0b3JQcm90b3R5cGVbaXRlcmF0b3JTeW1ib2xdID0gZnVuY3Rpb24gKCkge1xuICAgIHJldHVybiB0aGlzO1xuICB9O1xuXG4gIHZhciBnZXRQcm90byA9IE9iamVjdC5nZXRQcm90b3R5cGVPZjtcbiAgdmFyIE5hdGl2ZUl0ZXJhdG9yUHJvdG90eXBlID0gZ2V0UHJvdG8gJiYgZ2V0UHJvdG8oZ2V0UHJvdG8odmFsdWVzKFtdKSkpO1xuICBpZiAoTmF0aXZlSXRlcmF0b3JQcm90b3R5cGUgJiZcbiAgICAgIE5hdGl2ZUl0ZXJhdG9yUHJvdG90eXBlICE9PSBPcCAmJlxuICAgICAgaGFzT3duLmNhbGwoTmF0aXZlSXRlcmF0b3JQcm90b3R5cGUsIGl0ZXJhdG9yU3ltYm9sKSkge1xuICAgIC8vIFRoaXMgZW52aXJvbm1lbnQgaGFzIGEgbmF0aXZlICVJdGVyYXRvclByb3RvdHlwZSU7IHVzZSBpdCBpbnN0ZWFkXG4gICAgLy8gb2YgdGhlIHBvbHlmaWxsLlxuICAgIEl0ZXJhdG9yUHJvdG90eXBlID0gTmF0aXZlSXRlcmF0b3JQcm90b3R5cGU7XG4gIH1cblxuICB2YXIgR3AgPSBHZW5lcmF0b3JGdW5jdGlvblByb3RvdHlwZS5wcm90b3R5cGUgPVxuICAgIEdlbmVyYXRvci5wcm90b3R5cGUgPSBPYmplY3QuY3JlYXRlKEl0ZXJhdG9yUHJvdG90eXBlKTtcbiAgR2VuZXJhdG9yRnVuY3Rpb24ucHJvdG90eXBlID0gR3AuY29uc3RydWN0b3IgPSBHZW5lcmF0b3JGdW5jdGlvblByb3RvdHlwZTtcbiAgR2VuZXJhdG9yRnVuY3Rpb25Qcm90b3R5cGUuY29uc3RydWN0b3IgPSBHZW5lcmF0b3JGdW5jdGlvbjtcbiAgR2VuZXJhdG9yRnVuY3Rpb25Qcm90b3R5cGVbdG9TdHJpbmdUYWdTeW1ib2xdID1cbiAgICBHZW5lcmF0b3JGdW5jdGlvbi5kaXNwbGF5TmFtZSA9IFwiR2VuZXJhdG9yRnVuY3Rpb25cIjtcblxuICAvLyBIZWxwZXIgZm9yIGRlZmluaW5nIHRoZSAubmV4dCwgLnRocm93LCBhbmQgLnJldHVybiBtZXRob2RzIG9mIHRoZVxuICAvLyBJdGVyYXRvciBpbnRlcmZhY2UgaW4gdGVybXMgb2YgYSBzaW5nbGUgLl9pbnZva2UgbWV0aG9kLlxuICBmdW5jdGlvbiBkZWZpbmVJdGVyYXRvck1ldGhvZHMocHJvdG90eXBlKSB7XG4gICAgW1wibmV4dFwiLCBcInRocm93XCIsIFwicmV0dXJuXCJdLmZvckVhY2goZnVuY3Rpb24obWV0aG9kKSB7XG4gICAgICBwcm90b3R5cGVbbWV0aG9kXSA9IGZ1bmN0aW9uKGFyZykge1xuICAgICAgICByZXR1cm4gdGhpcy5faW52b2tlKG1ldGhvZCwgYXJnKTtcbiAgICAgIH07XG4gICAgfSk7XG4gIH1cblxuICBleHBvcnRzLmlzR2VuZXJhdG9yRnVuY3Rpb24gPSBmdW5jdGlvbihnZW5GdW4pIHtcbiAgICB2YXIgY3RvciA9IHR5cGVvZiBnZW5GdW4gPT09IFwiZnVuY3Rpb25cIiAmJiBnZW5GdW4uY29uc3RydWN0b3I7XG4gICAgcmV0dXJuIGN0b3JcbiAgICAgID8gY3RvciA9PT0gR2VuZXJhdG9yRnVuY3Rpb24gfHxcbiAgICAgICAgLy8gRm9yIHRoZSBuYXRpdmUgR2VuZXJhdG9yRnVuY3Rpb24gY29uc3RydWN0b3IsIHRoZSBiZXN0IHdlIGNhblxuICAgICAgICAvLyBkbyBpcyB0byBjaGVjayBpdHMgLm5hbWUgcHJvcGVydHkuXG4gICAgICAgIChjdG9yLmRpc3BsYXlOYW1lIHx8IGN0b3IubmFtZSkgPT09IFwiR2VuZXJhdG9yRnVuY3Rpb25cIlxuICAgICAgOiBmYWxzZTtcbiAgfTtcblxuICBleHBvcnRzLm1hcmsgPSBmdW5jdGlvbihnZW5GdW4pIHtcbiAgICBpZiAoT2JqZWN0LnNldFByb3RvdHlwZU9mKSB7XG4gICAgICBPYmplY3Quc2V0UHJvdG90eXBlT2YoZ2VuRnVuLCBHZW5lcmF0b3JGdW5jdGlvblByb3RvdHlwZSk7XG4gICAgfSBlbHNlIHtcbiAgICAgIGdlbkZ1bi5fX3Byb3RvX18gPSBHZW5lcmF0b3JGdW5jdGlvblByb3RvdHlwZTtcbiAgICAgIGlmICghKHRvU3RyaW5nVGFnU3ltYm9sIGluIGdlbkZ1bikpIHtcbiAgICAgICAgZ2VuRnVuW3RvU3RyaW5nVGFnU3ltYm9sXSA9IFwiR2VuZXJhdG9yRnVuY3Rpb25cIjtcbiAgICAgIH1cbiAgICB9XG4gICAgZ2VuRnVuLnByb3RvdHlwZSA9IE9iamVjdC5jcmVhdGUoR3ApO1xuICAgIHJldHVybiBnZW5GdW47XG4gIH07XG5cbiAgLy8gV2l0aGluIHRoZSBib2R5IG9mIGFueSBhc3luYyBmdW5jdGlvbiwgYGF3YWl0IHhgIGlzIHRyYW5zZm9ybWVkIHRvXG4gIC8vIGB5aWVsZCByZWdlbmVyYXRvclJ1bnRpbWUuYXdyYXAoeClgLCBzbyB0aGF0IHRoZSBydW50aW1lIGNhbiB0ZXN0XG4gIC8vIGBoYXNPd24uY2FsbCh2YWx1ZSwgXCJfX2F3YWl0XCIpYCB0byBkZXRlcm1pbmUgaWYgdGhlIHlpZWxkZWQgdmFsdWUgaXNcbiAgLy8gbWVhbnQgdG8gYmUgYXdhaXRlZC5cbiAgZXhwb3J0cy5hd3JhcCA9IGZ1bmN0aW9uKGFyZykge1xuICAgIHJldHVybiB7IF9fYXdhaXQ6IGFyZyB9O1xuICB9O1xuXG4gIGZ1bmN0aW9uIEFzeW5jSXRlcmF0b3IoZ2VuZXJhdG9yKSB7XG4gICAgZnVuY3Rpb24gaW52b2tlKG1ldGhvZCwgYXJnLCByZXNvbHZlLCByZWplY3QpIHtcbiAgICAgIHZhciByZWNvcmQgPSB0cnlDYXRjaChnZW5lcmF0b3JbbWV0aG9kXSwgZ2VuZXJhdG9yLCBhcmcpO1xuICAgICAgaWYgKHJlY29yZC50eXBlID09PSBcInRocm93XCIpIHtcbiAgICAgICAgcmVqZWN0KHJlY29yZC5hcmcpO1xuICAgICAgfSBlbHNlIHtcbiAgICAgICAgdmFyIHJlc3VsdCA9IHJlY29yZC5hcmc7XG4gICAgICAgIHZhciB2YWx1ZSA9IHJlc3VsdC52YWx1ZTtcbiAgICAgICAgaWYgKHZhbHVlICYmXG4gICAgICAgICAgICB0eXBlb2YgdmFsdWUgPT09IFwib2JqZWN0XCIgJiZcbiAgICAgICAgICAgIGhhc093bi5jYWxsKHZhbHVlLCBcIl9fYXdhaXRcIikpIHtcbiAgICAgICAgICByZXR1cm4gUHJvbWlzZS5yZXNvbHZlKHZhbHVlLl9fYXdhaXQpLnRoZW4oZnVuY3Rpb24odmFsdWUpIHtcbiAgICAgICAgICAgIGludm9rZShcIm5leHRcIiwgdmFsdWUsIHJlc29sdmUsIHJlamVjdCk7XG4gICAgICAgICAgfSwgZnVuY3Rpb24oZXJyKSB7XG4gICAgICAgICAgICBpbnZva2UoXCJ0aHJvd1wiLCBlcnIsIHJlc29sdmUsIHJlamVjdCk7XG4gICAgICAgICAgfSk7XG4gICAgICAgIH1cblxuICAgICAgICByZXR1cm4gUHJvbWlzZS5yZXNvbHZlKHZhbHVlKS50aGVuKGZ1bmN0aW9uKHVud3JhcHBlZCkge1xuICAgICAgICAgIC8vIFdoZW4gYSB5aWVsZGVkIFByb21pc2UgaXMgcmVzb2x2ZWQsIGl0cyBmaW5hbCB2YWx1ZSBiZWNvbWVzXG4gICAgICAgICAgLy8gdGhlIC52YWx1ZSBvZiB0aGUgUHJvbWlzZTx7dmFsdWUsZG9uZX0+IHJlc3VsdCBmb3IgdGhlXG4gICAgICAgICAgLy8gY3VycmVudCBpdGVyYXRpb24uXG4gICAgICAgICAgcmVzdWx0LnZhbHVlID0gdW53cmFwcGVkO1xuICAgICAgICAgIHJlc29sdmUocmVzdWx0KTtcbiAgICAgICAgfSwgZnVuY3Rpb24oZXJyb3IpIHtcbiAgICAgICAgICAvLyBJZiBhIHJlamVjdGVkIFByb21pc2Ugd2FzIHlpZWxkZWQsIHRocm93IHRoZSByZWplY3Rpb24gYmFja1xuICAgICAgICAgIC8vIGludG8gdGhlIGFzeW5jIGdlbmVyYXRvciBmdW5jdGlvbiBzbyBpdCBjYW4gYmUgaGFuZGxlZCB0aGVyZS5cbiAgICAgICAgICByZXR1cm4gaW52b2tlKFwidGhyb3dcIiwgZXJyb3IsIHJlc29sdmUsIHJlamVjdCk7XG4gICAgICAgIH0pO1xuICAgICAgfVxuICAgIH1cblxuICAgIHZhciBwcmV2aW91c1Byb21pc2U7XG5cbiAgICBmdW5jdGlvbiBlbnF1ZXVlKG1ldGhvZCwgYXJnKSB7XG4gICAgICBmdW5jdGlvbiBjYWxsSW52b2tlV2l0aE1ldGhvZEFuZEFyZygpIHtcbiAgICAgICAgcmV0dXJuIG5ldyBQcm9taXNlKGZ1bmN0aW9uKHJlc29sdmUsIHJlamVjdCkge1xuICAgICAgICAgIGludm9rZShtZXRob2QsIGFyZywgcmVzb2x2ZSwgcmVqZWN0KTtcbiAgICAgICAgfSk7XG4gICAgICB9XG5cbiAgICAgIHJldHVybiBwcmV2aW91c1Byb21pc2UgPVxuICAgICAgICAvLyBJZiBlbnF1ZXVlIGhhcyBiZWVuIGNhbGxlZCBiZWZvcmUsIHRoZW4gd2Ugd2FudCB0byB3YWl0IHVudGlsXG4gICAgICAgIC8vIGFsbCBwcmV2aW91cyBQcm9taXNlcyBoYXZlIGJlZW4gcmVzb2x2ZWQgYmVmb3JlIGNhbGxpbmcgaW52b2tlLFxuICAgICAgICAvLyBzbyB0aGF0IHJlc3VsdHMgYXJlIGFsd2F5cyBkZWxpdmVyZWQgaW4gdGhlIGNvcnJlY3Qgb3JkZXIuIElmXG4gICAgICAgIC8vIGVucXVldWUgaGFzIG5vdCBiZWVuIGNhbGxlZCBiZWZvcmUsIHRoZW4gaXQgaXMgaW1wb3J0YW50IHRvXG4gICAgICAgIC8vIGNhbGwgaW52b2tlIGltbWVkaWF0ZWx5LCB3aXRob3V0IHdhaXRpbmcgb24gYSBjYWxsYmFjayB0byBmaXJlLFxuICAgICAgICAvLyBzbyB0aGF0IHRoZSBhc3luYyBnZW5lcmF0b3IgZnVuY3Rpb24gaGFzIHRoZSBvcHBvcnR1bml0eSB0byBkb1xuICAgICAgICAvLyBhbnkgbmVjZXNzYXJ5IHNldHVwIGluIGEgcHJlZGljdGFibGUgd2F5LiBUaGlzIHByZWRpY3RhYmlsaXR5XG4gICAgICAgIC8vIGlzIHdoeSB0aGUgUHJvbWlzZSBjb25zdHJ1Y3RvciBzeW5jaHJvbm91c2x5IGludm9rZXMgaXRzXG4gICAgICAgIC8vIGV4ZWN1dG9yIGNhbGxiYWNrLCBhbmQgd2h5IGFzeW5jIGZ1bmN0aW9ucyBzeW5jaHJvbm91c2x5XG4gICAgICAgIC8vIGV4ZWN1dGUgY29kZSBiZWZvcmUgdGhlIGZpcnN0IGF3YWl0LiBTaW5jZSB3ZSBpbXBsZW1lbnQgc2ltcGxlXG4gICAgICAgIC8vIGFzeW5jIGZ1bmN0aW9ucyBpbiB0ZXJtcyBvZiBhc3luYyBnZW5lcmF0b3JzLCBpdCBpcyBlc3BlY2lhbGx5XG4gICAgICAgIC8vIGltcG9ydGFudCB0byBnZXQgdGhpcyByaWdodCwgZXZlbiB0aG91Z2ggaXQgcmVxdWlyZXMgY2FyZS5cbiAgICAgICAgcHJldmlvdXNQcm9taXNlID8gcHJldmlvdXNQcm9taXNlLnRoZW4oXG4gICAgICAgICAgY2FsbEludm9rZVdpdGhNZXRob2RBbmRBcmcsXG4gICAgICAgICAgLy8gQXZvaWQgcHJvcGFnYXRpbmcgZmFpbHVyZXMgdG8gUHJvbWlzZXMgcmV0dXJuZWQgYnkgbGF0ZXJcbiAgICAgICAgICAvLyBpbnZvY2F0aW9ucyBvZiB0aGUgaXRlcmF0b3IuXG4gICAgICAgICAgY2FsbEludm9rZVdpdGhNZXRob2RBbmRBcmdcbiAgICAgICAgKSA6IGNhbGxJbnZva2VXaXRoTWV0aG9kQW5kQXJnKCk7XG4gICAgfVxuXG4gICAgLy8gRGVmaW5lIHRoZSB1bmlmaWVkIGhlbHBlciBtZXRob2QgdGhhdCBpcyB1c2VkIHRvIGltcGxlbWVudCAubmV4dCxcbiAgICAvLyAudGhyb3csIGFuZCAucmV0dXJuIChzZWUgZGVmaW5lSXRlcmF0b3JNZXRob2RzKS5cbiAgICB0aGlzLl9pbnZva2UgPSBlbnF1ZXVlO1xuICB9XG5cbiAgZGVmaW5lSXRlcmF0b3JNZXRob2RzKEFzeW5jSXRlcmF0b3IucHJvdG90eXBlKTtcbiAgQXN5bmNJdGVyYXRvci5wcm90b3R5cGVbYXN5bmNJdGVyYXRvclN5bWJvbF0gPSBmdW5jdGlvbiAoKSB7XG4gICAgcmV0dXJuIHRoaXM7XG4gIH07XG4gIGV4cG9ydHMuQXN5bmNJdGVyYXRvciA9IEFzeW5jSXRlcmF0b3I7XG5cbiAgLy8gTm90ZSB0aGF0IHNpbXBsZSBhc3luYyBmdW5jdGlvbnMgYXJlIGltcGxlbWVudGVkIG9uIHRvcCBvZlxuICAvLyBBc3luY0l0ZXJhdG9yIG9iamVjdHM7IHRoZXkganVzdCByZXR1cm4gYSBQcm9taXNlIGZvciB0aGUgdmFsdWUgb2ZcbiAgLy8gdGhlIGZpbmFsIHJlc3VsdCBwcm9kdWNlZCBieSB0aGUgaXRlcmF0b3IuXG4gIGV4cG9ydHMuYXN5bmMgPSBmdW5jdGlvbihpbm5lckZuLCBvdXRlckZuLCBzZWxmLCB0cnlMb2NzTGlzdCkge1xuICAgIHZhciBpdGVyID0gbmV3IEFzeW5jSXRlcmF0b3IoXG4gICAgICB3cmFwKGlubmVyRm4sIG91dGVyRm4sIHNlbGYsIHRyeUxvY3NMaXN0KVxuICAgICk7XG5cbiAgICByZXR1cm4gZXhwb3J0cy5pc0dlbmVyYXRvckZ1bmN0aW9uKG91dGVyRm4pXG4gICAgICA/IGl0ZXIgLy8gSWYgb3V0ZXJGbiBpcyBhIGdlbmVyYXRvciwgcmV0dXJuIHRoZSBmdWxsIGl0ZXJhdG9yLlxuICAgICAgOiBpdGVyLm5leHQoKS50aGVuKGZ1bmN0aW9uKHJlc3VsdCkge1xuICAgICAgICAgIHJldHVybiByZXN1bHQuZG9uZSA/IHJlc3VsdC52YWx1ZSA6IGl0ZXIubmV4dCgpO1xuICAgICAgICB9KTtcbiAgfTtcblxuICBmdW5jdGlvbiBtYWtlSW52b2tlTWV0aG9kKGlubmVyRm4sIHNlbGYsIGNvbnRleHQpIHtcbiAgICB2YXIgc3RhdGUgPSBHZW5TdGF0ZVN1c3BlbmRlZFN0YXJ0O1xuXG4gICAgcmV0dXJuIGZ1bmN0aW9uIGludm9rZShtZXRob2QsIGFyZykge1xuICAgICAgaWYgKHN0YXRlID09PSBHZW5TdGF0ZUV4ZWN1dGluZykge1xuICAgICAgICB0aHJvdyBuZXcgRXJyb3IoXCJHZW5lcmF0b3IgaXMgYWxyZWFkeSBydW5uaW5nXCIpO1xuICAgICAgfVxuXG4gICAgICBpZiAoc3RhdGUgPT09IEdlblN0YXRlQ29tcGxldGVkKSB7XG4gICAgICAgIGlmIChtZXRob2QgPT09IFwidGhyb3dcIikge1xuICAgICAgICAgIHRocm93IGFyZztcbiAgICAgICAgfVxuXG4gICAgICAgIC8vIEJlIGZvcmdpdmluZywgcGVyIDI1LjMuMy4zLjMgb2YgdGhlIHNwZWM6XG4gICAgICAgIC8vIGh0dHBzOi8vcGVvcGxlLm1vemlsbGEub3JnL35qb3JlbmRvcmZmL2VzNi1kcmFmdC5odG1sI3NlYy1nZW5lcmF0b3JyZXN1bWVcbiAgICAgICAgcmV0dXJuIGRvbmVSZXN1bHQoKTtcbiAgICAgIH1cblxuICAgICAgY29udGV4dC5tZXRob2QgPSBtZXRob2Q7XG4gICAgICBjb250ZXh0LmFyZyA9IGFyZztcblxuICAgICAgd2hpbGUgKHRydWUpIHtcbiAgICAgICAgdmFyIGRlbGVnYXRlID0gY29udGV4dC5kZWxlZ2F0ZTtcbiAgICAgICAgaWYgKGRlbGVnYXRlKSB7XG4gICAgICAgICAgdmFyIGRlbGVnYXRlUmVzdWx0ID0gbWF5YmVJbnZva2VEZWxlZ2F0ZShkZWxlZ2F0ZSwgY29udGV4dCk7XG4gICAgICAgICAgaWYgKGRlbGVnYXRlUmVzdWx0KSB7XG4gICAgICAgICAgICBpZiAoZGVsZWdhdGVSZXN1bHQgPT09IENvbnRpbnVlU2VudGluZWwpIGNvbnRpbnVlO1xuICAgICAgICAgICAgcmV0dXJuIGRlbGVnYXRlUmVzdWx0O1xuICAgICAgICAgIH1cbiAgICAgICAgfVxuXG4gICAgICAgIGlmIChjb250ZXh0Lm1ldGhvZCA9PT0gXCJuZXh0XCIpIHtcbiAgICAgICAgICAvLyBTZXR0aW5nIGNvbnRleHQuX3NlbnQgZm9yIGxlZ2FjeSBzdXBwb3J0IG9mIEJhYmVsJ3NcbiAgICAgICAgICAvLyBmdW5jdGlvbi5zZW50IGltcGxlbWVudGF0aW9uLlxuICAgICAgICAgIGNvbnRleHQuc2VudCA9IGNvbnRleHQuX3NlbnQgPSBjb250ZXh0LmFyZztcblxuICAgICAgICB9IGVsc2UgaWYgKGNvbnRleHQubWV0aG9kID09PSBcInRocm93XCIpIHtcbiAgICAgICAgICBpZiAoc3RhdGUgPT09IEdlblN0YXRlU3VzcGVuZGVkU3RhcnQpIHtcbiAgICAgICAgICAgIHN0YXRlID0gR2VuU3RhdGVDb21wbGV0ZWQ7XG4gICAgICAgICAgICB0aHJvdyBjb250ZXh0LmFyZztcbiAgICAgICAgICB9XG5cbiAgICAgICAgICBjb250ZXh0LmRpc3BhdGNoRXhjZXB0aW9uKGNvbnRleHQuYXJnKTtcblxuICAgICAgICB9IGVsc2UgaWYgKGNvbnRleHQubWV0aG9kID09PSBcInJldHVyblwiKSB7XG4gICAgICAgICAgY29udGV4dC5hYnJ1cHQoXCJyZXR1cm5cIiwgY29udGV4dC5hcmcpO1xuICAgICAgICB9XG5cbiAgICAgICAgc3RhdGUgPSBHZW5TdGF0ZUV4ZWN1dGluZztcblxuICAgICAgICB2YXIgcmVjb3JkID0gdHJ5Q2F0Y2goaW5uZXJGbiwgc2VsZiwgY29udGV4dCk7XG4gICAgICAgIGlmIChyZWNvcmQudHlwZSA9PT0gXCJub3JtYWxcIikge1xuICAgICAgICAgIC8vIElmIGFuIGV4Y2VwdGlvbiBpcyB0aHJvd24gZnJvbSBpbm5lckZuLCB3ZSBsZWF2ZSBzdGF0ZSA9PT1cbiAgICAgICAgICAvLyBHZW5TdGF0ZUV4ZWN1dGluZyBhbmQgbG9vcCBiYWNrIGZvciBhbm90aGVyIGludm9jYXRpb24uXG4gICAgICAgICAgc3RhdGUgPSBjb250ZXh0LmRvbmVcbiAgICAgICAgICAgID8gR2VuU3RhdGVDb21wbGV0ZWRcbiAgICAgICAgICAgIDogR2VuU3RhdGVTdXNwZW5kZWRZaWVsZDtcblxuICAgICAgICAgIGlmIChyZWNvcmQuYXJnID09PSBDb250aW51ZVNlbnRpbmVsKSB7XG4gICAgICAgICAgICBjb250aW51ZTtcbiAgICAgICAgICB9XG5cbiAgICAgICAgICByZXR1cm4ge1xuICAgICAgICAgICAgdmFsdWU6IHJlY29yZC5hcmcsXG4gICAgICAgICAgICBkb25lOiBjb250ZXh0LmRvbmVcbiAgICAgICAgICB9O1xuXG4gICAgICAgIH0gZWxzZSBpZiAocmVjb3JkLnR5cGUgPT09IFwidGhyb3dcIikge1xuICAgICAgICAgIHN0YXRlID0gR2VuU3RhdGVDb21wbGV0ZWQ7XG4gICAgICAgICAgLy8gRGlzcGF0Y2ggdGhlIGV4Y2VwdGlvbiBieSBsb29waW5nIGJhY2sgYXJvdW5kIHRvIHRoZVxuICAgICAgICAgIC8vIGNvbnRleHQuZGlzcGF0Y2hFeGNlcHRpb24oY29udGV4dC5hcmcpIGNhbGwgYWJvdmUuXG4gICAgICAgICAgY29udGV4dC5tZXRob2QgPSBcInRocm93XCI7XG4gICAgICAgICAgY29udGV4dC5hcmcgPSByZWNvcmQuYXJnO1xuICAgICAgICB9XG4gICAgICB9XG4gICAgfTtcbiAgfVxuXG4gIC8vIENhbGwgZGVsZWdhdGUuaXRlcmF0b3JbY29udGV4dC5tZXRob2RdKGNvbnRleHQuYXJnKSBhbmQgaGFuZGxlIHRoZVxuICAvLyByZXN1bHQsIGVpdGhlciBieSByZXR1cm5pbmcgYSB7IHZhbHVlLCBkb25lIH0gcmVzdWx0IGZyb20gdGhlXG4gIC8vIGRlbGVnYXRlIGl0ZXJhdG9yLCBvciBieSBtb2RpZnlpbmcgY29udGV4dC5tZXRob2QgYW5kIGNvbnRleHQuYXJnLFxuICAvLyBzZXR0aW5nIGNvbnRleHQuZGVsZWdhdGUgdG8gbnVsbCwgYW5kIHJldHVybmluZyB0aGUgQ29udGludWVTZW50aW5lbC5cbiAgZnVuY3Rpb24gbWF5YmVJbnZva2VEZWxlZ2F0ZShkZWxlZ2F0ZSwgY29udGV4dCkge1xuICAgIHZhciBtZXRob2QgPSBkZWxlZ2F0ZS5pdGVyYXRvcltjb250ZXh0Lm1ldGhvZF07XG4gICAgaWYgKG1ldGhvZCA9PT0gdW5kZWZpbmVkKSB7XG4gICAgICAvLyBBIC50aHJvdyBvciAucmV0dXJuIHdoZW4gdGhlIGRlbGVnYXRlIGl0ZXJhdG9yIGhhcyBubyAudGhyb3dcbiAgICAgIC8vIG1ldGhvZCBhbHdheXMgdGVybWluYXRlcyB0aGUgeWllbGQqIGxvb3AuXG4gICAgICBjb250ZXh0LmRlbGVnYXRlID0gbnVsbDtcblxuICAgICAgaWYgKGNvbnRleHQubWV0aG9kID09PSBcInRocm93XCIpIHtcbiAgICAgICAgLy8gTm90ZTogW1wicmV0dXJuXCJdIG11c3QgYmUgdXNlZCBmb3IgRVMzIHBhcnNpbmcgY29tcGF0aWJpbGl0eS5cbiAgICAgICAgaWYgKGRlbGVnYXRlLml0ZXJhdG9yW1wicmV0dXJuXCJdKSB7XG4gICAgICAgICAgLy8gSWYgdGhlIGRlbGVnYXRlIGl0ZXJhdG9yIGhhcyBhIHJldHVybiBtZXRob2QsIGdpdmUgaXQgYVxuICAgICAgICAgIC8vIGNoYW5jZSB0byBjbGVhbiB1cC5cbiAgICAgICAgICBjb250ZXh0Lm1ldGhvZCA9IFwicmV0dXJuXCI7XG4gICAgICAgICAgY29udGV4dC5hcmcgPSB1bmRlZmluZWQ7XG4gICAgICAgICAgbWF5YmVJbnZva2VEZWxlZ2F0ZShkZWxlZ2F0ZSwgY29udGV4dCk7XG5cbiAgICAgICAgICBpZiAoY29udGV4dC5tZXRob2QgPT09IFwidGhyb3dcIikge1xuICAgICAgICAgICAgLy8gSWYgbWF5YmVJbnZva2VEZWxlZ2F0ZShjb250ZXh0KSBjaGFuZ2VkIGNvbnRleHQubWV0aG9kIGZyb21cbiAgICAgICAgICAgIC8vIFwicmV0dXJuXCIgdG8gXCJ0aHJvd1wiLCBsZXQgdGhhdCBvdmVycmlkZSB0aGUgVHlwZUVycm9yIGJlbG93LlxuICAgICAgICAgICAgcmV0dXJuIENvbnRpbnVlU2VudGluZWw7XG4gICAgICAgICAgfVxuICAgICAgICB9XG5cbiAgICAgICAgY29udGV4dC5tZXRob2QgPSBcInRocm93XCI7XG4gICAgICAgIGNvbnRleHQuYXJnID0gbmV3IFR5cGVFcnJvcihcbiAgICAgICAgICBcIlRoZSBpdGVyYXRvciBkb2VzIG5vdCBwcm92aWRlIGEgJ3Rocm93JyBtZXRob2RcIik7XG4gICAgICB9XG5cbiAgICAgIHJldHVybiBDb250aW51ZVNlbnRpbmVsO1xuICAgIH1cblxuICAgIHZhciByZWNvcmQgPSB0cnlDYXRjaChtZXRob2QsIGRlbGVnYXRlLml0ZXJhdG9yLCBjb250ZXh0LmFyZyk7XG5cbiAgICBpZiAocmVjb3JkLnR5cGUgPT09IFwidGhyb3dcIikge1xuICAgICAgY29udGV4dC5tZXRob2QgPSBcInRocm93XCI7XG4gICAgICBjb250ZXh0LmFyZyA9IHJlY29yZC5hcmc7XG4gICAgICBjb250ZXh0LmRlbGVnYXRlID0gbnVsbDtcbiAgICAgIHJldHVybiBDb250aW51ZVNlbnRpbmVsO1xuICAgIH1cblxuICAgIHZhciBpbmZvID0gcmVjb3JkLmFyZztcblxuICAgIGlmICghIGluZm8pIHtcbiAgICAgIGNvbnRleHQubWV0aG9kID0gXCJ0aHJvd1wiO1xuICAgICAgY29udGV4dC5hcmcgPSBuZXcgVHlwZUVycm9yKFwiaXRlcmF0b3IgcmVzdWx0IGlzIG5vdCBhbiBvYmplY3RcIik7XG4gICAgICBjb250ZXh0LmRlbGVnYXRlID0gbnVsbDtcbiAgICAgIHJldHVybiBDb250aW51ZVNlbnRpbmVsO1xuICAgIH1cblxuICAgIGlmIChpbmZvLmRvbmUpIHtcbiAgICAgIC8vIEFzc2lnbiB0aGUgcmVzdWx0IG9mIHRoZSBmaW5pc2hlZCBkZWxlZ2F0ZSB0byB0aGUgdGVtcG9yYXJ5XG4gICAgICAvLyB2YXJpYWJsZSBzcGVjaWZpZWQgYnkgZGVsZWdhdGUucmVzdWx0TmFtZSAoc2VlIGRlbGVnYXRlWWllbGQpLlxuICAgICAgY29udGV4dFtkZWxlZ2F0ZS5yZXN1bHROYW1lXSA9IGluZm8udmFsdWU7XG5cbiAgICAgIC8vIFJlc3VtZSBleGVjdXRpb24gYXQgdGhlIGRlc2lyZWQgbG9jYXRpb24gKHNlZSBkZWxlZ2F0ZVlpZWxkKS5cbiAgICAgIGNvbnRleHQubmV4dCA9IGRlbGVnYXRlLm5leHRMb2M7XG5cbiAgICAgIC8vIElmIGNvbnRleHQubWV0aG9kIHdhcyBcInRocm93XCIgYnV0IHRoZSBkZWxlZ2F0ZSBoYW5kbGVkIHRoZVxuICAgICAgLy8gZXhjZXB0aW9uLCBsZXQgdGhlIG91dGVyIGdlbmVyYXRvciBwcm9jZWVkIG5vcm1hbGx5LiBJZlxuICAgICAgLy8gY29udGV4dC5tZXRob2Qgd2FzIFwibmV4dFwiLCBmb3JnZXQgY29udGV4dC5hcmcgc2luY2UgaXQgaGFzIGJlZW5cbiAgICAgIC8vIFwiY29uc3VtZWRcIiBieSB0aGUgZGVsZWdhdGUgaXRlcmF0b3IuIElmIGNvbnRleHQubWV0aG9kIHdhc1xuICAgICAgLy8gXCJyZXR1cm5cIiwgYWxsb3cgdGhlIG9yaWdpbmFsIC5yZXR1cm4gY2FsbCB0byBjb250aW51ZSBpbiB0aGVcbiAgICAgIC8vIG91dGVyIGdlbmVyYXRvci5cbiAgICAgIGlmIChjb250ZXh0Lm1ldGhvZCAhPT0gXCJyZXR1cm5cIikge1xuICAgICAgICBjb250ZXh0Lm1ldGhvZCA9IFwibmV4dFwiO1xuICAgICAgICBjb250ZXh0LmFyZyA9IHVuZGVmaW5lZDtcbiAgICAgIH1cblxuICAgIH0gZWxzZSB7XG4gICAgICAvLyBSZS15aWVsZCB0aGUgcmVzdWx0IHJldHVybmVkIGJ5IHRoZSBkZWxlZ2F0ZSBtZXRob2QuXG4gICAgICByZXR1cm4gaW5mbztcbiAgICB9XG5cbiAgICAvLyBUaGUgZGVsZWdhdGUgaXRlcmF0b3IgaXMgZmluaXNoZWQsIHNvIGZvcmdldCBpdCBhbmQgY29udGludWUgd2l0aFxuICAgIC8vIHRoZSBvdXRlciBnZW5lcmF0b3IuXG4gICAgY29udGV4dC5kZWxlZ2F0ZSA9IG51bGw7XG4gICAgcmV0dXJuIENvbnRpbnVlU2VudGluZWw7XG4gIH1cblxuICAvLyBEZWZpbmUgR2VuZXJhdG9yLnByb3RvdHlwZS57bmV4dCx0aHJvdyxyZXR1cm59IGluIHRlcm1zIG9mIHRoZVxuICAvLyB1bmlmaWVkIC5faW52b2tlIGhlbHBlciBtZXRob2QuXG4gIGRlZmluZUl0ZXJhdG9yTWV0aG9kcyhHcCk7XG5cbiAgR3BbdG9TdHJpbmdUYWdTeW1ib2xdID0gXCJHZW5lcmF0b3JcIjtcblxuICAvLyBBIEdlbmVyYXRvciBzaG91bGQgYWx3YXlzIHJldHVybiBpdHNlbGYgYXMgdGhlIGl0ZXJhdG9yIG9iamVjdCB3aGVuIHRoZVxuICAvLyBAQGl0ZXJhdG9yIGZ1bmN0aW9uIGlzIGNhbGxlZCBvbiBpdC4gU29tZSBicm93c2VycycgaW1wbGVtZW50YXRpb25zIG9mIHRoZVxuICAvLyBpdGVyYXRvciBwcm90b3R5cGUgY2hhaW4gaW5jb3JyZWN0bHkgaW1wbGVtZW50IHRoaXMsIGNhdXNpbmcgdGhlIEdlbmVyYXRvclxuICAvLyBvYmplY3QgdG8gbm90IGJlIHJldHVybmVkIGZyb20gdGhpcyBjYWxsLiBUaGlzIGVuc3VyZXMgdGhhdCBkb2Vzbid0IGhhcHBlbi5cbiAgLy8gU2VlIGh0dHBzOi8vZ2l0aHViLmNvbS9mYWNlYm9vay9yZWdlbmVyYXRvci9pc3N1ZXMvMjc0IGZvciBtb3JlIGRldGFpbHMuXG4gIEdwW2l0ZXJhdG9yU3ltYm9sXSA9IGZ1bmN0aW9uKCkge1xuICAgIHJldHVybiB0aGlzO1xuICB9O1xuXG4gIEdwLnRvU3RyaW5nID0gZnVuY3Rpb24oKSB7XG4gICAgcmV0dXJuIFwiW29iamVjdCBHZW5lcmF0b3JdXCI7XG4gIH07XG5cbiAgZnVuY3Rpb24gcHVzaFRyeUVudHJ5KGxvY3MpIHtcbiAgICB2YXIgZW50cnkgPSB7IHRyeUxvYzogbG9jc1swXSB9O1xuXG4gICAgaWYgKDEgaW4gbG9jcykge1xuICAgICAgZW50cnkuY2F0Y2hMb2MgPSBsb2NzWzFdO1xuICAgIH1cblxuICAgIGlmICgyIGluIGxvY3MpIHtcbiAgICAgIGVudHJ5LmZpbmFsbHlMb2MgPSBsb2NzWzJdO1xuICAgICAgZW50cnkuYWZ0ZXJMb2MgPSBsb2NzWzNdO1xuICAgIH1cblxuICAgIHRoaXMudHJ5RW50cmllcy5wdXNoKGVudHJ5KTtcbiAgfVxuXG4gIGZ1bmN0aW9uIHJlc2V0VHJ5RW50cnkoZW50cnkpIHtcbiAgICB2YXIgcmVjb3JkID0gZW50cnkuY29tcGxldGlvbiB8fCB7fTtcbiAgICByZWNvcmQudHlwZSA9IFwibm9ybWFsXCI7XG4gICAgZGVsZXRlIHJlY29yZC5hcmc7XG4gICAgZW50cnkuY29tcGxldGlvbiA9IHJlY29yZDtcbiAgfVxuXG4gIGZ1bmN0aW9uIENvbnRleHQodHJ5TG9jc0xpc3QpIHtcbiAgICAvLyBUaGUgcm9vdCBlbnRyeSBvYmplY3QgKGVmZmVjdGl2ZWx5IGEgdHJ5IHN0YXRlbWVudCB3aXRob3V0IGEgY2F0Y2hcbiAgICAvLyBvciBhIGZpbmFsbHkgYmxvY2spIGdpdmVzIHVzIGEgcGxhY2UgdG8gc3RvcmUgdmFsdWVzIHRocm93biBmcm9tXG4gICAgLy8gbG9jYXRpb25zIHdoZXJlIHRoZXJlIGlzIG5vIGVuY2xvc2luZyB0cnkgc3RhdGVtZW50LlxuICAgIHRoaXMudHJ5RW50cmllcyA9IFt7IHRyeUxvYzogXCJyb290XCIgfV07XG4gICAgdHJ5TG9jc0xpc3QuZm9yRWFjaChwdXNoVHJ5RW50cnksIHRoaXMpO1xuICAgIHRoaXMucmVzZXQodHJ1ZSk7XG4gIH1cblxuICBleHBvcnRzLmtleXMgPSBmdW5jdGlvbihvYmplY3QpIHtcbiAgICB2YXIga2V5cyA9IFtdO1xuICAgIGZvciAodmFyIGtleSBpbiBvYmplY3QpIHtcbiAgICAgIGtleXMucHVzaChrZXkpO1xuICAgIH1cbiAgICBrZXlzLnJldmVyc2UoKTtcblxuICAgIC8vIFJhdGhlciB0aGFuIHJldHVybmluZyBhbiBvYmplY3Qgd2l0aCBhIG5leHQgbWV0aG9kLCB3ZSBrZWVwXG4gICAgLy8gdGhpbmdzIHNpbXBsZSBhbmQgcmV0dXJuIHRoZSBuZXh0IGZ1bmN0aW9uIGl0c2VsZi5cbiAgICByZXR1cm4gZnVuY3Rpb24gbmV4dCgpIHtcbiAgICAgIHdoaWxlIChrZXlzLmxlbmd0aCkge1xuICAgICAgICB2YXIga2V5ID0ga2V5cy5wb3AoKTtcbiAgICAgICAgaWYgKGtleSBpbiBvYmplY3QpIHtcbiAgICAgICAgICBuZXh0LnZhbHVlID0ga2V5O1xuICAgICAgICAgIG5leHQuZG9uZSA9IGZhbHNlO1xuICAgICAgICAgIHJldHVybiBuZXh0O1xuICAgICAgICB9XG4gICAgICB9XG5cbiAgICAgIC8vIFRvIGF2b2lkIGNyZWF0aW5nIGFuIGFkZGl0aW9uYWwgb2JqZWN0LCB3ZSBqdXN0IGhhbmcgdGhlIC52YWx1ZVxuICAgICAgLy8gYW5kIC5kb25lIHByb3BlcnRpZXMgb2ZmIHRoZSBuZXh0IGZ1bmN0aW9uIG9iamVjdCBpdHNlbGYuIFRoaXNcbiAgICAgIC8vIGFsc28gZW5zdXJlcyB0aGF0IHRoZSBtaW5pZmllciB3aWxsIG5vdCBhbm9ueW1pemUgdGhlIGZ1bmN0aW9uLlxuICAgICAgbmV4dC5kb25lID0gdHJ1ZTtcbiAgICAgIHJldHVybiBuZXh0O1xuICAgIH07XG4gIH07XG5cbiAgZnVuY3Rpb24gdmFsdWVzKGl0ZXJhYmxlKSB7XG4gICAgaWYgKGl0ZXJhYmxlKSB7XG4gICAgICB2YXIgaXRlcmF0b3JNZXRob2QgPSBpdGVyYWJsZVtpdGVyYXRvclN5bWJvbF07XG4gICAgICBpZiAoaXRlcmF0b3JNZXRob2QpIHtcbiAgICAgICAgcmV0dXJuIGl0ZXJhdG9yTWV0aG9kLmNhbGwoaXRlcmFibGUpO1xuICAgICAgfVxuXG4gICAgICBpZiAodHlwZW9mIGl0ZXJhYmxlLm5leHQgPT09IFwiZnVuY3Rpb25cIikge1xuICAgICAgICByZXR1cm4gaXRlcmFibGU7XG4gICAgICB9XG5cbiAgICAgIGlmICghaXNOYU4oaXRlcmFibGUubGVuZ3RoKSkge1xuICAgICAgICB2YXIgaSA9IC0xLCBuZXh0ID0gZnVuY3Rpb24gbmV4dCgpIHtcbiAgICAgICAgICB3aGlsZSAoKytpIDwgaXRlcmFibGUubGVuZ3RoKSB7XG4gICAgICAgICAgICBpZiAoaGFzT3duLmNhbGwoaXRlcmFibGUsIGkpKSB7XG4gICAgICAgICAgICAgIG5leHQudmFsdWUgPSBpdGVyYWJsZVtpXTtcbiAgICAgICAgICAgICAgbmV4dC5kb25lID0gZmFsc2U7XG4gICAgICAgICAgICAgIHJldHVybiBuZXh0O1xuICAgICAgICAgICAgfVxuICAgICAgICAgIH1cblxuICAgICAgICAgIG5leHQudmFsdWUgPSB1bmRlZmluZWQ7XG4gICAgICAgICAgbmV4dC5kb25lID0gdHJ1ZTtcblxuICAgICAgICAgIHJldHVybiBuZXh0O1xuICAgICAgICB9O1xuXG4gICAgICAgIHJldHVybiBuZXh0Lm5leHQgPSBuZXh0O1xuICAgICAgfVxuICAgIH1cblxuICAgIC8vIFJldHVybiBhbiBpdGVyYXRvciB3aXRoIG5vIHZhbHVlcy5cbiAgICByZXR1cm4geyBuZXh0OiBkb25lUmVzdWx0IH07XG4gIH1cbiAgZXhwb3J0cy52YWx1ZXMgPSB2YWx1ZXM7XG5cbiAgZnVuY3Rpb24gZG9uZVJlc3VsdCgpIHtcbiAgICByZXR1cm4geyB2YWx1ZTogdW5kZWZpbmVkLCBkb25lOiB0cnVlIH07XG4gIH1cblxuICBDb250ZXh0LnByb3RvdHlwZSA9IHtcbiAgICBjb25zdHJ1Y3RvcjogQ29udGV4dCxcblxuICAgIHJlc2V0OiBmdW5jdGlvbihza2lwVGVtcFJlc2V0KSB7XG4gICAgICB0aGlzLnByZXYgPSAwO1xuICAgICAgdGhpcy5uZXh0ID0gMDtcbiAgICAgIC8vIFJlc2V0dGluZyBjb250ZXh0Ll9zZW50IGZvciBsZWdhY3kgc3VwcG9ydCBvZiBCYWJlbCdzXG4gICAgICAvLyBmdW5jdGlvbi5zZW50IGltcGxlbWVudGF0aW9uLlxuICAgICAgdGhpcy5zZW50ID0gdGhpcy5fc2VudCA9IHVuZGVmaW5lZDtcbiAgICAgIHRoaXMuZG9uZSA9IGZhbHNlO1xuICAgICAgdGhpcy5kZWxlZ2F0ZSA9IG51bGw7XG5cbiAgICAgIHRoaXMubWV0aG9kID0gXCJuZXh0XCI7XG4gICAgICB0aGlzLmFyZyA9IHVuZGVmaW5lZDtcblxuICAgICAgdGhpcy50cnlFbnRyaWVzLmZvckVhY2gocmVzZXRUcnlFbnRyeSk7XG5cbiAgICAgIGlmICghc2tpcFRlbXBSZXNldCkge1xuICAgICAgICBmb3IgKHZhciBuYW1lIGluIHRoaXMpIHtcbiAgICAgICAgICAvLyBOb3Qgc3VyZSBhYm91dCB0aGUgb3B0aW1hbCBvcmRlciBvZiB0aGVzZSBjb25kaXRpb25zOlxuICAgICAgICAgIGlmIChuYW1lLmNoYXJBdCgwKSA9PT0gXCJ0XCIgJiZcbiAgICAgICAgICAgICAgaGFzT3duLmNhbGwodGhpcywgbmFtZSkgJiZcbiAgICAgICAgICAgICAgIWlzTmFOKCtuYW1lLnNsaWNlKDEpKSkge1xuICAgICAgICAgICAgdGhpc1tuYW1lXSA9IHVuZGVmaW5lZDtcbiAgICAgICAgICB9XG4gICAgICAgIH1cbiAgICAgIH1cbiAgICB9LFxuXG4gICAgc3RvcDogZnVuY3Rpb24oKSB7XG4gICAgICB0aGlzLmRvbmUgPSB0cnVlO1xuXG4gICAgICB2YXIgcm9vdEVudHJ5ID0gdGhpcy50cnlFbnRyaWVzWzBdO1xuICAgICAgdmFyIHJvb3RSZWNvcmQgPSByb290RW50cnkuY29tcGxldGlvbjtcbiAgICAgIGlmIChyb290UmVjb3JkLnR5cGUgPT09IFwidGhyb3dcIikge1xuICAgICAgICB0aHJvdyByb290UmVjb3JkLmFyZztcbiAgICAgIH1cblxuICAgICAgcmV0dXJuIHRoaXMucnZhbDtcbiAgICB9LFxuXG4gICAgZGlzcGF0Y2hFeGNlcHRpb246IGZ1bmN0aW9uKGV4Y2VwdGlvbikge1xuICAgICAgaWYgKHRoaXMuZG9uZSkge1xuICAgICAgICB0aHJvdyBleGNlcHRpb247XG4gICAgICB9XG5cbiAgICAgIHZhciBjb250ZXh0ID0gdGhpcztcbiAgICAgIGZ1bmN0aW9uIGhhbmRsZShsb2MsIGNhdWdodCkge1xuICAgICAgICByZWNvcmQudHlwZSA9IFwidGhyb3dcIjtcbiAgICAgICAgcmVjb3JkLmFyZyA9IGV4Y2VwdGlvbjtcbiAgICAgICAgY29udGV4dC5uZXh0ID0gbG9jO1xuXG4gICAgICAgIGlmIChjYXVnaHQpIHtcbiAgICAgICAgICAvLyBJZiB0aGUgZGlzcGF0Y2hlZCBleGNlcHRpb24gd2FzIGNhdWdodCBieSBhIGNhdGNoIGJsb2NrLFxuICAgICAgICAgIC8vIHRoZW4gbGV0IHRoYXQgY2F0Y2ggYmxvY2sgaGFuZGxlIHRoZSBleGNlcHRpb24gbm9ybWFsbHkuXG4gICAgICAgICAgY29udGV4dC5tZXRob2QgPSBcIm5leHRcIjtcbiAgICAgICAgICBjb250ZXh0LmFyZyA9IHVuZGVmaW5lZDtcbiAgICAgICAgfVxuXG4gICAgICAgIHJldHVybiAhISBjYXVnaHQ7XG4gICAgICB9XG5cbiAgICAgIGZvciAodmFyIGkgPSB0aGlzLnRyeUVudHJpZXMubGVuZ3RoIC0gMTsgaSA+PSAwOyAtLWkpIHtcbiAgICAgICAgdmFyIGVudHJ5ID0gdGhpcy50cnlFbnRyaWVzW2ldO1xuICAgICAgICB2YXIgcmVjb3JkID0gZW50cnkuY29tcGxldGlvbjtcblxuICAgICAgICBpZiAoZW50cnkudHJ5TG9jID09PSBcInJvb3RcIikge1xuICAgICAgICAgIC8vIEV4Y2VwdGlvbiB0aHJvd24gb3V0c2lkZSBvZiBhbnkgdHJ5IGJsb2NrIHRoYXQgY291bGQgaGFuZGxlXG4gICAgICAgICAgLy8gaXQsIHNvIHNldCB0aGUgY29tcGxldGlvbiB2YWx1ZSBvZiB0aGUgZW50aXJlIGZ1bmN0aW9uIHRvXG4gICAgICAgICAgLy8gdGhyb3cgdGhlIGV4Y2VwdGlvbi5cbiAgICAgICAgICByZXR1cm4gaGFuZGxlKFwiZW5kXCIpO1xuICAgICAgICB9XG5cbiAgICAgICAgaWYgKGVudHJ5LnRyeUxvYyA8PSB0aGlzLnByZXYpIHtcbiAgICAgICAgICB2YXIgaGFzQ2F0Y2ggPSBoYXNPd24uY2FsbChlbnRyeSwgXCJjYXRjaExvY1wiKTtcbiAgICAgICAgICB2YXIgaGFzRmluYWxseSA9IGhhc093bi5jYWxsKGVudHJ5LCBcImZpbmFsbHlMb2NcIik7XG5cbiAgICAgICAgICBpZiAoaGFzQ2F0Y2ggJiYgaGFzRmluYWxseSkge1xuICAgICAgICAgICAgaWYgKHRoaXMucHJldiA8IGVudHJ5LmNhdGNoTG9jKSB7XG4gICAgICAgICAgICAgIHJldHVybiBoYW5kbGUoZW50cnkuY2F0Y2hMb2MsIHRydWUpO1xuICAgICAgICAgICAgfSBlbHNlIGlmICh0aGlzLnByZXYgPCBlbnRyeS5maW5hbGx5TG9jKSB7XG4gICAgICAgICAgICAgIHJldHVybiBoYW5kbGUoZW50cnkuZmluYWxseUxvYyk7XG4gICAgICAgICAgICB9XG5cbiAgICAgICAgICB9IGVsc2UgaWYgKGhhc0NhdGNoKSB7XG4gICAgICAgICAgICBpZiAodGhpcy5wcmV2IDwgZW50cnkuY2F0Y2hMb2MpIHtcbiAgICAgICAgICAgICAgcmV0dXJuIGhhbmRsZShlbnRyeS5jYXRjaExvYywgdHJ1ZSk7XG4gICAgICAgICAgICB9XG5cbiAgICAgICAgICB9IGVsc2UgaWYgKGhhc0ZpbmFsbHkpIHtcbiAgICAgICAgICAgIGlmICh0aGlzLnByZXYgPCBlbnRyeS5maW5hbGx5TG9jKSB7XG4gICAgICAgICAgICAgIHJldHVybiBoYW5kbGUoZW50cnkuZmluYWxseUxvYyk7XG4gICAgICAgICAgICB9XG5cbiAgICAgICAgICB9IGVsc2Uge1xuICAgICAgICAgICAgdGhyb3cgbmV3IEVycm9yKFwidHJ5IHN0YXRlbWVudCB3aXRob3V0IGNhdGNoIG9yIGZpbmFsbHlcIik7XG4gICAgICAgICAgfVxuICAgICAgICB9XG4gICAgICB9XG4gICAgfSxcblxuICAgIGFicnVwdDogZnVuY3Rpb24odHlwZSwgYXJnKSB7XG4gICAgICBmb3IgKHZhciBpID0gdGhpcy50cnlFbnRyaWVzLmxlbmd0aCAtIDE7IGkgPj0gMDsgLS1pKSB7XG4gICAgICAgIHZhciBlbnRyeSA9IHRoaXMudHJ5RW50cmllc1tpXTtcbiAgICAgICAgaWYgKGVudHJ5LnRyeUxvYyA8PSB0aGlzLnByZXYgJiZcbiAgICAgICAgICAgIGhhc093bi5jYWxsKGVudHJ5LCBcImZpbmFsbHlMb2NcIikgJiZcbiAgICAgICAgICAgIHRoaXMucHJldiA8IGVudHJ5LmZpbmFsbHlMb2MpIHtcbiAgICAgICAgICB2YXIgZmluYWxseUVudHJ5ID0gZW50cnk7XG4gICAgICAgICAgYnJlYWs7XG4gICAgICAgIH1cbiAgICAgIH1cblxuICAgICAgaWYgKGZpbmFsbHlFbnRyeSAmJlxuICAgICAgICAgICh0eXBlID09PSBcImJyZWFrXCIgfHxcbiAgICAgICAgICAgdHlwZSA9PT0gXCJjb250aW51ZVwiKSAmJlxuICAgICAgICAgIGZpbmFsbHlFbnRyeS50cnlMb2MgPD0gYXJnICYmXG4gICAgICAgICAgYXJnIDw9IGZpbmFsbHlFbnRyeS5maW5hbGx5TG9jKSB7XG4gICAgICAgIC8vIElnbm9yZSB0aGUgZmluYWxseSBlbnRyeSBpZiBjb250cm9sIGlzIG5vdCBqdW1waW5nIHRvIGFcbiAgICAgICAgLy8gbG9jYXRpb24gb3V0c2lkZSB0aGUgdHJ5L2NhdGNoIGJsb2NrLlxuICAgICAgICBmaW5hbGx5RW50cnkgPSBudWxsO1xuICAgICAgfVxuXG4gICAgICB2YXIgcmVjb3JkID0gZmluYWxseUVudHJ5ID8gZmluYWxseUVudHJ5LmNvbXBsZXRpb24gOiB7fTtcbiAgICAgIHJlY29yZC50eXBlID0gdHlwZTtcbiAgICAgIHJlY29yZC5hcmcgPSBhcmc7XG5cbiAgICAgIGlmIChmaW5hbGx5RW50cnkpIHtcbiAgICAgICAgdGhpcy5tZXRob2QgPSBcIm5leHRcIjtcbiAgICAgICAgdGhpcy5uZXh0ID0gZmluYWxseUVudHJ5LmZpbmFsbHlMb2M7XG4gICAgICAgIHJldHVybiBDb250aW51ZVNlbnRpbmVsO1xuICAgICAgfVxuXG4gICAgICByZXR1cm4gdGhpcy5jb21wbGV0ZShyZWNvcmQpO1xuICAgIH0sXG5cbiAgICBjb21wbGV0ZTogZnVuY3Rpb24ocmVjb3JkLCBhZnRlckxvYykge1xuICAgICAgaWYgKHJlY29yZC50eXBlID09PSBcInRocm93XCIpIHtcbiAgICAgICAgdGhyb3cgcmVjb3JkLmFyZztcbiAgICAgIH1cblxuICAgICAgaWYgKHJlY29yZC50eXBlID09PSBcImJyZWFrXCIgfHxcbiAgICAgICAgICByZWNvcmQudHlwZSA9PT0gXCJjb250aW51ZVwiKSB7XG4gICAgICAgIHRoaXMubmV4dCA9IHJlY29yZC5hcmc7XG4gICAgICB9IGVsc2UgaWYgKHJlY29yZC50eXBlID09PSBcInJldHVyblwiKSB7XG4gICAgICAgIHRoaXMucnZhbCA9IHRoaXMuYXJnID0gcmVjb3JkLmFyZztcbiAgICAgICAgdGhpcy5tZXRob2QgPSBcInJldHVyblwiO1xuICAgICAgICB0aGlzLm5leHQgPSBcImVuZFwiO1xuICAgICAgfSBlbHNlIGlmIChyZWNvcmQudHlwZSA9PT0gXCJub3JtYWxcIiAmJiBhZnRlckxvYykge1xuICAgICAgICB0aGlzLm5leHQgPSBhZnRlckxvYztcbiAgICAgIH1cblxuICAgICAgcmV0dXJuIENvbnRpbnVlU2VudGluZWw7XG4gICAgfSxcblxuICAgIGZpbmlzaDogZnVuY3Rpb24oZmluYWxseUxvYykge1xuICAgICAgZm9yICh2YXIgaSA9IHRoaXMudHJ5RW50cmllcy5sZW5ndGggLSAxOyBpID49IDA7IC0taSkge1xuICAgICAgICB2YXIgZW50cnkgPSB0aGlzLnRyeUVudHJpZXNbaV07XG4gICAgICAgIGlmIChlbnRyeS5maW5hbGx5TG9jID09PSBmaW5hbGx5TG9jKSB7XG4gICAgICAgICAgdGhpcy5jb21wbGV0ZShlbnRyeS5jb21wbGV0aW9uLCBlbnRyeS5hZnRlckxvYyk7XG4gICAgICAgICAgcmVzZXRUcnlFbnRyeShlbnRyeSk7XG4gICAgICAgICAgcmV0dXJuIENvbnRpbnVlU2VudGluZWw7XG4gICAgICAgIH1cbiAgICAgIH1cbiAgICB9LFxuXG4gICAgXCJjYXRjaFwiOiBmdW5jdGlvbih0cnlMb2MpIHtcbiAgICAgIGZvciAodmFyIGkgPSB0aGlzLnRyeUVudHJpZXMubGVuZ3RoIC0gMTsgaSA+PSAwOyAtLWkpIHtcbiAgICAgICAgdmFyIGVudHJ5ID0gdGhpcy50cnlFbnRyaWVzW2ldO1xuICAgICAgICBpZiAoZW50cnkudHJ5TG9jID09PSB0cnlMb2MpIHtcbiAgICAgICAgICB2YXIgcmVjb3JkID0gZW50cnkuY29tcGxldGlvbjtcbiAgICAgICAgICBpZiAocmVjb3JkLnR5cGUgPT09IFwidGhyb3dcIikge1xuICAgICAgICAgICAgdmFyIHRocm93biA9IHJlY29yZC5hcmc7XG4gICAgICAgICAgICByZXNldFRyeUVudHJ5KGVudHJ5KTtcbiAgICAgICAgICB9XG4gICAgICAgICAgcmV0dXJuIHRocm93bjtcbiAgICAgICAgfVxuICAgICAgfVxuXG4gICAgICAvLyBUaGUgY29udGV4dC5jYXRjaCBtZXRob2QgbXVzdCBvbmx5IGJlIGNhbGxlZCB3aXRoIGEgbG9jYXRpb25cbiAgICAgIC8vIGFyZ3VtZW50IHRoYXQgY29ycmVzcG9uZHMgdG8gYSBrbm93biBjYXRjaCBibG9jay5cbiAgICAgIHRocm93IG5ldyBFcnJvcihcImlsbGVnYWwgY2F0Y2ggYXR0ZW1wdFwiKTtcbiAgICB9LFxuXG4gICAgZGVsZWdhdGVZaWVsZDogZnVuY3Rpb24oaXRlcmFibGUsIHJlc3VsdE5hbWUsIG5leHRMb2MpIHtcbiAgICAgIHRoaXMuZGVsZWdhdGUgPSB7XG4gICAgICAgIGl0ZXJhdG9yOiB2YWx1ZXMoaXRlcmFibGUpLFxuICAgICAgICByZXN1bHROYW1lOiByZXN1bHROYW1lLFxuICAgICAgICBuZXh0TG9jOiBuZXh0TG9jXG4gICAgICB9O1xuXG4gICAgICBpZiAodGhpcy5tZXRob2QgPT09IFwibmV4dFwiKSB7XG4gICAgICAgIC8vIERlbGliZXJhdGVseSBmb3JnZXQgdGhlIGxhc3Qgc2VudCB2YWx1ZSBzbyB0aGF0IHdlIGRvbid0XG4gICAgICAgIC8vIGFjY2lkZW50YWxseSBwYXNzIGl0IG9uIHRvIHRoZSBkZWxlZ2F0ZS5cbiAgICAgICAgdGhpcy5hcmcgPSB1bmRlZmluZWQ7XG4gICAgICB9XG5cbiAgICAgIHJldHVybiBDb250aW51ZVNlbnRpbmVsO1xuICAgIH1cbiAgfTtcblxuICAvLyBSZWdhcmRsZXNzIG9mIHdoZXRoZXIgdGhpcyBzY3JpcHQgaXMgZXhlY3V0aW5nIGFzIGEgQ29tbW9uSlMgbW9kdWxlXG4gIC8vIG9yIG5vdCwgcmV0dXJuIHRoZSBydW50aW1lIG9iamVjdCBzbyB0aGF0IHdlIGNhbiBkZWNsYXJlIHRoZSB2YXJpYWJsZVxuICAvLyByZWdlbmVyYXRvclJ1bnRpbWUgaW4gdGhlIG91dGVyIHNjb3BlLCB3aGljaCBhbGxvd3MgdGhpcyBtb2R1bGUgdG8gYmVcbiAgLy8gaW5qZWN0ZWQgZWFzaWx5IGJ5IGBiaW4vcmVnZW5lcmF0b3IgLS1pbmNsdWRlLXJ1bnRpbWUgc2NyaXB0LmpzYC5cbiAgcmV0dXJuIGV4cG9ydHM7XG5cbn0oXG4gIC8vIElmIHRoaXMgc2NyaXB0IGlzIGV4ZWN1dGluZyBhcyBhIENvbW1vbkpTIG1vZHVsZSwgdXNlIG1vZHVsZS5leHBvcnRzXG4gIC8vIGFzIHRoZSByZWdlbmVyYXRvclJ1bnRpbWUgbmFtZXNwYWNlLiBPdGhlcndpc2UgY3JlYXRlIGEgbmV3IGVtcHR5XG4gIC8vIG9iamVjdC4gRWl0aGVyIHdheSwgdGhlIHJlc3VsdGluZyBvYmplY3Qgd2lsbCBiZSB1c2VkIHRvIGluaXRpYWxpemVcbiAgLy8gdGhlIHJlZ2VuZXJhdG9yUnVudGltZSB2YXJpYWJsZSBhdCB0aGUgdG9wIG9mIHRoaXMgZmlsZS5cbiAgdHlwZW9mIG1vZHVsZSA9PT0gXCJvYmplY3RcIiA/IG1vZHVsZS5leHBvcnRzIDoge31cbikpO1xuXG50cnkge1xuICByZWdlbmVyYXRvclJ1bnRpbWUgPSBydW50aW1lO1xufSBjYXRjaCAoYWNjaWRlbnRhbFN0cmljdE1vZGUpIHtcbiAgLy8gVGhpcyBtb2R1bGUgc2hvdWxkIG5vdCBiZSBydW5uaW5nIGluIHN0cmljdCBtb2RlLCBzbyB0aGUgYWJvdmVcbiAgLy8gYXNzaWdubWVudCBzaG91bGQgYWx3YXlzIHdvcmsgdW5sZXNzIHNvbWV0aGluZyBpcyBtaXNjb25maWd1cmVkLiBKdXN0XG4gIC8vIGluIGNhc2UgcnVudGltZS5qcyBhY2NpZGVudGFsbHkgcnVucyBpbiBzdHJpY3QgbW9kZSwgd2UgY2FuIGVzY2FwZVxuICAvLyBzdHJpY3QgbW9kZSB1c2luZyBhIGdsb2JhbCBGdW5jdGlvbiBjYWxsLiBUaGlzIGNvdWxkIGNvbmNlaXZhYmx5IGZhaWxcbiAgLy8gaWYgYSBDb250ZW50IFNlY3VyaXR5IFBvbGljeSBmb3JiaWRzIHVzaW5nIEZ1bmN0aW9uLCBidXQgaW4gdGhhdCBjYXNlXG4gIC8vIHRoZSBwcm9wZXIgc29sdXRpb24gaXMgdG8gZml4IHRoZSBhY2NpZGVudGFsIHN0cmljdCBtb2RlIHByb2JsZW0uIElmXG4gIC8vIHlvdSd2ZSBtaXNjb25maWd1cmVkIHlvdXIgYnVuZGxlciB0byBmb3JjZSBzdHJpY3QgbW9kZSBhbmQgYXBwbGllZCBhXG4gIC8vIENTUCB0byBmb3JiaWQgRnVuY3Rpb24sIGFuZCB5b3UncmUgbm90IHdpbGxpbmcgdG8gZml4IGVpdGhlciBvZiB0aG9zZVxuICAvLyBwcm9ibGVtcywgcGxlYXNlIGRldGFpbCB5b3VyIHVuaXF1ZSBwcmVkaWNhbWVudCBpbiBhIEdpdEh1YiBpc3N1ZS5cbiAgRnVuY3Rpb24oXCJyXCIsIFwicmVnZW5lcmF0b3JSdW50aW1lID0gclwiKShydW50aW1lKTtcbn1cbiIsImNvbnN0IHJlZ2VuZXJhdG9yUnVudGltZSA9IHJlcXVpcmUoXCJyZWdlbmVyYXRvci1ydW50aW1lXCIpO1xyXG5cclxuY29uc3QgdG9wbGluZSA9IGRvY3VtZW50LnF1ZXJ5U2VsZWN0b3IoXCIubWVudVwiKTtcclxuY29uc3QgbW9iaWxlTWVudSA9IGRvY3VtZW50LmdldEVsZW1lbnRCeUlkKFwibW9iaWxlTWVudVwiKTtcclxuY29uc3QgY2xvc2VCdG4gPSBkb2N1bWVudC5nZXRFbGVtZW50QnlJZChcImNsb3NlQnRuXCIpO1xyXG5jb25zdCBidXJnZXIgPSBkb2N1bWVudC5nZXRFbGVtZW50QnlJZChcImJ1cmdlclwiKTtcclxuY29uc3QgbW9iaWxlTGlzdCA9IGRvY3VtZW50LmdldEVsZW1lbnRCeUlkKFwibW9iaWxlTGlzdFwiKTtcclxuY29uc3Qgc2VlTW9yZSA9IGRvY3VtZW50LmdldEVsZW1lbnRCeUlkKFwic2VlTW9yZVwiKTtcclxuY29uc3QgYWNjb3JkZW9uID0gZG9jdW1lbnQuZ2V0RWxlbWVudEJ5SWQoXCJhY2NvcmRlb25cIik7XHJcbmNvbnN0IHJlYWRNb3JlMSA9IGRvY3VtZW50LmdldEVsZW1lbnRCeUlkKFwicmVhZE1vcmUxXCIpO1xyXG5jb25zdCByZWFkTW9yZTIgPSBkb2N1bWVudC5nZXRFbGVtZW50QnlJZChcInJlYWRNb3JlMlwiKTtcclxuY29uc3QgcmVhZExlc3MxID0gZG9jdW1lbnQuZ2V0RWxlbWVudEJ5SWQoXCJyZWFkTGVzczFcIik7XHJcbmNvbnN0IHJlYWRMZXNzMiA9IGRvY3VtZW50LmdldEVsZW1lbnRCeUlkKFwicmVhZExlc3MyXCIpO1xyXG5jb25zdCBsaXN0Rmlyc3QgPSBkb2N1bWVudC5nZXRFbGVtZW50QnlJZChcImxpc3RGaXJzdFwiKTtcclxuY29uc3QgdGV4dEZpcnN0ID0gZG9jdW1lbnQuZ2V0RWxlbWVudEJ5SWQoXCJ0ZXh0Rmlyc3RcIik7XHJcbmNvbnN0IHRleHRTZWNvbmQgPSBkb2N1bWVudC5nZXRFbGVtZW50QnlJZChcInRleHRTZWNvbmRcIik7XHJcbmNvbnN0IGNhcmRzID0gZG9jdW1lbnQuZ2V0RWxlbWVudEJ5SWQoXCJjYXJkc1wiKTtcclxuY29uc3QgY2FyZEFjdGl2ZSA9IGRvY3VtZW50LmdldEVsZW1lbnRCeUlkKFwiY2FyZEFjdGl2ZVwiKTtcclxubGV0IGNvdW50ZXIgPSAzO1xyXG5sZXQgcmFpc2VyID0gMztcclxuY29uc3QgcHJvZHVjdHMgPSBbXHJcbiAge1xyXG4gICAgc3JjOiBcImltZy8xLiBJbmRvb3IuanBnXCIsXHJcbiAgICBzdWJ0aXRsZTogXCJJbmRvb3IgZW5lcmd5IHNlcnZpY2VzXCIsXHJcbiAgICB0ZXh0OlxyXG4gICAgICBcIldlIGhlbHBlZCBJbmRvb3IgZW5lcmd5IHNlcnZpY2VzIHRvIGdyZWF0eSBzaW1wbGlmeSB0aGVpciBjYXNlIG1hbmFnZW1lbnQgc3lzdGVtLi4uXCJcclxuICB9LFxyXG4gIHtcclxuICAgIHNyYzogXCJpbWcvMi4gQmlyZGllLmpwZ1wiLFxyXG4gICAgc3VidGl0bGU6IFwiQmlyZGllIEdvbGQgVG91cnNcIixcclxuICAgIHRleHQ6XHJcbiAgICAgIFwiV2UgaGVscGVkIEJpcmR5IEdvbGYgVG91cnMgdG8gc3RheSByZWxldmVhbnQgb24gYW4gaW5jbHJlYXNpbmdseSBjb21wZXRpdGl2ZSBtYXJrZXQuLi5cIlxyXG4gIH0sXHJcbiAge1xyXG4gICAgc3JjOiBcImltZy8zLiBOb3dXaGVyZS5qcGdcIixcclxuICAgIHN1YnRpdGxlOiBcIk5vd1doZXJlXCIsXHJcbiAgICB0ZXh0OlxyXG4gICAgICBcIldlIGJ1aWx0IGEgcmVjb21tZW5kYXRpb25zIGFwcCBmb3IgcGVvcGxlIHdvcmtpbmcgaW4gY3JlYXRpdmUgaW5kdXN0cmllcy4uLlwiXHJcbiAgfSxcclxuICB7XHJcbiAgICBzcmM6IFwiaW1nLzQuIEZ5bmRpcXN2YWpwZW4uanBnXCIsXHJcbiAgICBzdWJ0aXRsZTogXCJGeW5kaXFzdmFqcGVuXCIsXHJcbiAgICB0ZXh0OlxyXG4gICAgICBcIldlIGNyZWF0ZWQgYW4gYXBwIHRoYXQgaGVscGVkIGN1c3RvbWVycyBmaW5kIGdpZnRzIGFtb25nIG1vcmUgdGhhbiAyOTAwMDAwIGl0ZW1zLi4uXCJcclxuICB9LFxyXG4gIHtcclxuICAgIHNyYzogXCJpbWcvNS4gQnl0aGp1bC5qcGdcIixcclxuICAgIHN1YnRpdGxlOiBcIkJ5dGhqdWxcIixcclxuICAgIHRleHQ6XHJcbiAgICAgIFwiV2UgY3JlYXRlZCB0aXJlIGZhc2hpb24gZm9yIHRoZSBpbmNyZWFzaW5nbHkgZWdhbGl0YXJpYW4gY2FyIG1haW50aW5hY2UgbWFya2V0Li4uXCJcclxuICB9LFxyXG4gIHtcclxuICAgIHNyYzogXCJpbWcvNi4gVGlja2luLmpwZ1wiLFxyXG4gICAgc3VidGl0bGU6IFwiVGlja2luXCIsXHJcbiAgICB0ZXh0OlxyXG4gICAgICBcIldlIGludmVudGVkIGEgdGltZSByZXBvcnRpbmcgc3lzdGVtIGZvciBwZW9wbGUgd2hvIGhhdGUgdGltZSB0cmFja2luZy4uLlwiXHJcbiAgfSxcclxuICB7XHJcbiAgICBzcmM6IFwiaW1nLzcuIFViZXJtZWRzLmpwZ1wiLFxyXG4gICAgc3VidGl0bGU6IFwiVWJlcm1lZHNcIixcclxuICAgIHRleHQ6XHJcbiAgICAgIFwiV2UgY3JlYXRlZCBhbiBhcHAgdGhhdCBoZWxwZWQgY3VzdG9tZXJzIGZpbmQgZ2lmdHMgYW1vbmcgbW9yZSB0aGFuIDI5MDAwMDAgaXRlbXMuLi5cIlxyXG4gIH0sXHJcbiAge1xyXG4gICAgc3JjOiBcImltZy84LiBWw6RzdHRyYWZpayBDYWxjdWxhdG9yLmpwZ1wiLFxyXG4gICAgc3VidGl0bGU6IFwiVsOkc3R0cmFmaWsgQ2FsY3VsYXRvclwiLFxyXG4gICAgdGV4dDpcclxuICAgICAgXCJXZSBjcmVhdGVkIHRpcmUgZmFzaGlvbiBmb3IgdGhlIGluY3JlYXNpbmdseSBlZ2FsaXRhcmlhbiBjYXIgbWFpbnRpbmFjZSBtYXJrZXQuLi5cIlxyXG4gIH0sXHJcbiAge1xyXG4gICAgc3JjOiBcImltZy85LiBUcsOkbmluZ3NwYXJ0bmVyLmpwZ1wiLFxyXG4gICAgc3VidGl0bGU6IFwiVHLDpG5pbmdzcGFydG5lclwiLFxyXG4gICAgdGV4dDpcclxuICAgICAgXCJXZSBpbnZlbnRlZCBhIHRpbWUgcmVwb3J0aW5nIHN5c3RlbSBmb3IgcGVvcGxlIHdobyBoYXRlIHRpbWUgdHJhY2tpbmcuLi5cIlxyXG4gIH1cclxuXTtcclxuXHJcbmRvY3VtZW50LmFkZEV2ZW50TGlzdGVuZXIoXCJzY3JvbGxcIiwgKCkgPT4ge1xyXG4gIGlmICh3aW5kb3cucGFnZVlPZmZzZXQgPCB0b3BsaW5lLmNsaWVudEhlaWdodCkge1xyXG4gICAgdG9wbGluZS5jbGFzc0xpc3QucmVtb3ZlKFwiZml4ZWRcIik7XHJcbiAgfSBlbHNlIHtcclxuICAgIHRvcGxpbmUuY2xhc3NMaXN0LmFkZChcImZpeGVkXCIpO1xyXG4gIH1cclxufSk7XHJcblxyXG5idXJnZXIub25jbGljayA9IGUgPT4ge1xyXG4gIGUucHJldmVudERlZmF1bHQoKTtcclxuICBtb2JpbGVNZW51LmNsYXNzTGlzdC50b2dnbGUoXCJoaWRlXCIpO1xyXG59O1xyXG5cclxuY2xvc2VCdG4ub25jbGljayA9IGUgPT4ge1xyXG4gIGUucHJldmVudERlZmF1bHQoKTtcclxuICBtb2JpbGVNZW51LmNsYXNzTGlzdC50b2dnbGUoXCJoaWRlXCIpO1xyXG59O1xyXG5cclxubW9iaWxlTGlzdC5vbmNsaWNrID0gKCkgPT4ge1xyXG4gIG1vYmlsZU1lbnUuY2xhc3NMaXN0LnRvZ2dsZShcImhpZGVcIik7XHJcbn07XHJcblxyXG5hY2NvcmRlb24uYWRkRXZlbnRMaXN0ZW5lcihcImNsaWNrXCIsIGUgPT4ge1xyXG4gIGxldCB0YXJnZXQgPSBlLnRhcmdldDtcclxuICBjb25zdCBsaXN0ID0gZG9jdW1lbnQuZ2V0RWxlbWVudHNCeUNsYXNzTmFtZShcImhvdy13ZS1kb19fdGFibGV0LWl0ZW1cIik7XHJcbiAgbGV0IGFyciA9IFsuLi5saXN0XTtcclxuICBpZiAodGFyZ2V0LmNsYXNzTGlzdC5jb250YWlucygnc2hvdycpKSB7XHJcbiAgICB0YXJnZXQuY2xhc3NMaXN0LnRvZ2dsZShcInNob3dcIik7XHJcbiAgfSBlbHNlIHtcclxuICAgIGFyci5tYXAoaSA9PiBpLmNsYXNzTGlzdC5yZW1vdmUoXCJzaG93XCIpKTtcclxuICAgIHRhcmdldC5jbGFzc0xpc3QudG9nZ2xlKFwic2hvd1wiKTtcclxuICB9XHJcbn0pO1xyXG5cclxuY2FyZHMuYWRkRXZlbnRMaXN0ZW5lcihcIm1vdXNlb3ZlclwiLCBlID0+IHtcclxuICBjb25zdCB0YXJnZXQgPSBlLnRhcmdldDtcclxuICBjb25zdCBjaGlsZHMgPSBjYXJkcy5jaGlsZHJlbjtcclxuICBpZih0YXJnZXQuY2xhc3NMaXN0LmNvbnRhaW5zKCdtZXRob2RzX19jYXJkJykpIHtcclxuICAgIGZvciAobGV0IGk9MCwgY2hpbGQ7IGNoaWxkID0gY2hpbGRzW2ldOyBpKyspIHtcclxuICAgICAgY2hpbGQuY2xhc3NMaXN0LnJlbW92ZSgnYWN0aXZlJylcclxuICAgIH1cclxuICAgIHRhcmdldC5jbGFzc0xpc3QuYWRkKCdhY3RpdmUnKTtcclxuICB9IGVsc2UgcmV0dXJuXHJcbn0pO1xyXG5cclxucmVhZE1vcmUxLm9uY2xpY2sgPSAoKSA9PiB7XHJcbiAgbGlzdEZpcnN0LmNsYXNzTGlzdC50b2dnbGUoXCJtb3JlXCIpO1xyXG4gIHRleHRGaXJzdC5jbGFzc0xpc3QudG9nZ2xlKFwibW9yZVwiKTtcclxuICByZWFkTW9yZTEuY2xhc3NMaXN0LnRvZ2dsZShcImhpZGRlblwiKTtcclxuICByZWFkTGVzczEuY2xhc3NMaXN0LnRvZ2dsZShcImhpZGRlblwiKTtcclxufTtcclxuXHJcbnJlYWRMZXNzMS5vbmNsaWNrID0gKCkgPT4ge1xyXG4gIGxpc3RGaXJzdC5jbGFzc0xpc3QudG9nZ2xlKFwibW9yZVwiKTtcclxuICB0ZXh0Rmlyc3QuY2xhc3NMaXN0LnRvZ2dsZShcIm1vcmVcIik7XHJcbiAgcmVhZE1vcmUxLmNsYXNzTGlzdC50b2dnbGUoXCJoaWRkZW5cIik7XHJcbiAgcmVhZExlc3MxLmNsYXNzTGlzdC50b2dnbGUoXCJoaWRkZW5cIik7XHJcbn07XHJcblxyXG5yZWFkTW9yZTIub25jbGljayA9ICgpID0+IHtcclxuICB0ZXh0U2Vjb25kLmNsYXNzTGlzdC50b2dnbGUoXCJtb3JlXCIpO1xyXG4gIHJlYWRNb3JlMi5jbGFzc0xpc3QudG9nZ2xlKFwiaGlkZGVuXCIpO1xyXG4gIHJlYWRMZXNzMi5jbGFzc0xpc3QudG9nZ2xlKFwiaGlkZGVuXCIpO1xyXG59O1xyXG5cclxucmVhZExlc3MyLm9uY2xpY2sgPSAoKSA9PiB7XHJcbiAgdGV4dFNlY29uZC5jbGFzc0xpc3QudG9nZ2xlKFwibW9yZVwiKTtcclxuICByZWFkTW9yZTIuY2xhc3NMaXN0LnRvZ2dsZShcImhpZGRlblwiKTtcclxuICByZWFkTGVzczIuY2xhc3NMaXN0LnRvZ2dsZShcImhpZGRlblwiKTtcclxufTtcclxuXHJcbmNvbnN0IHJlbmRlclByb2R1Y3RzID0gaXRlbSA9PiB7XHJcbiAgcmV0dXJuIGA8ZGl2IGNsYXNzPVwiY29sLTEyIGNvbC1tZC02IGNvbC1sZy00XCI+XHJcbiAgPGRpdiBjbGFzcz1cInByb2plY3RzX19jYXJkXCI+XHJcbiAgICA8ZGl2IGNsYXNzPVwicHJvamVjdHNfX2ltZy13cmFwcGVyXCI+PGltZyBzcmM9XCIke2l0ZW0uc3JjfVwiIGFsdD1cIm1hc2tcIj48L2Rpdj5cclxuICAgIDxkaXYgY2xhc3M9XCJwcm9qZWN0c19faW5mb1wiPlxyXG4gICAgICA8aDQgY2xhc3M9XCJwcm9qZWN0c19fc3VidGl0bGVcIj4ke2l0ZW0uc3VidGl0bGV9PC9oND5cclxuICAgICAgPHAgY2xhc3M9XCJwcm9qZWN0c19fdGV4dFwiPiR7aXRlbS50ZXh0fTwvcD5cclxuICAgIDwvZGl2PlxyXG4gIDwvZGl2PlxyXG48L2Rpdj5gO1xyXG59O1xyXG5cclxubGV0IHJlbmRlclNlY3Rpb24gPSBwcm9qZWN0c0RhdGEgPT4ge1xyXG4gIGNvbnN0IHByb2plY3RzID0gcHJvamVjdHNEYXRhLm1hcChlbGVtZW50ID0+IHJlbmRlclByb2R1Y3RzKGVsZW1lbnQpKTtcclxuICBkb2N1bWVudC5nZXRFbGVtZW50QnlJZChcInByb2plY3RzUmVuZGVyXCIpLmlubmVySFRNTCA9IHByb2plY3RzLmpvaW4oXCJcIik7XHJcbn07XHJcblxyXG5zZWVNb3JlLm9uY2xpY2sgPSBlID0+IHtcclxuICBlLnByZXZlbnREZWZhdWx0KCk7XHJcbiAgY291bnRlciArPSByYWlzZXI7XHJcbiAgcmVuZGVyU2VjdGlvbihwcm9kdWN0cy5zbGljZSgwLCBjb3VudGVyKSk7XHJcbn07XHJcblxyXG53aW5kb3cuYWRkRXZlbnRMaXN0ZW5lcihcIkRPTUNvbnRlbnRMb2FkZWRcIiwgKCkgPT4ge1xyXG4gIGNvbnN0IHdpdGRoQ291bnRlciA9IGFzeW5jICgpID0+IHtcclxuICAgIHN3aXRjaCAodHJ1ZSkge1xyXG4gICAgICBjYXNlIGRvY3VtZW50LmRvY3VtZW50RWxlbWVudC5jbGllbnRXaWR0aCA+IDc2ODpcclxuICAgICAgICBjb3VudGVyID0gOTtcclxuICAgICAgICBicmVhaztcclxuICAgICAgY2FzZSBkb2N1bWVudC5kb2N1bWVudEVsZW1lbnQuY2xpZW50V2lkdGggPiA0MTQ6XHJcbiAgICAgICAgY291bnRlciA9IDQ7XHJcbiAgICAgICAgcmFpc2VyID0gNDtcclxuICAgICAgICBicmVhaztcclxuICAgICAgZGVmYXVsdDpcclxuICAgICAgICBjb3VudGVyID0gMztcclxuICAgICAgICByYWlzZXIgPSAzO1xyXG4gICAgICAgIGJyZWFrO1xyXG4gICAgfVxyXG4gIH07XHJcbiAgd2l0ZGhDb3VudGVyKCk7XHJcbiAgcmVuZGVyU2VjdGlvbihwcm9kdWN0cy5zbGljZSgwLCBjb3VudGVyKSk7XHJcbn0pO1xyXG4iXSwicHJlRXhpc3RpbmdDb21tZW50IjoiLy8jIHNvdXJjZU1hcHBpbmdVUkw9ZGF0YTphcHBsaWNhdGlvbi9qc29uO2NoYXJzZXQ9dXRmLTg7YmFzZTY0LGV5SjJaWEp6YVc5dUlqb3pMQ0p6YjNWeVkyVnpJanBiSW01dlpHVmZiVzlrZFd4bGN5OWljbTkzYzJWeUxYQmhZMnN2WDNCeVpXeDFaR1V1YW5NaUxDSnViMlJsWDIxdlpIVnNaWE12Y21WblpXNWxjbUYwYjNJdGNuVnVkR2x0WlM5eWRXNTBhVzFsTG1weklpd2ljSEp2YW1WamRITXZkMmhwZEdWd2IzSjBMWE5wZEdVdmMzSmpMMnB6TDJGd2NDNXFjeUpkTENKdVlXMWxjeUk2VzEwc0ltMWhjSEJwYm1keklqb2lRVUZCUVR0QlEwRkJPMEZCUTBFN1FVRkRRVHRCUVVOQk8wRkJRMEU3UVVGRFFUdEJRVU5CTzBGQlEwRTdRVUZEUVR0QlFVTkJPMEZCUTBFN1FVRkRRVHRCUVVOQk8wRkJRMEU3UVVGRFFUdEJRVU5CTzBGQlEwRTdRVUZEUVR0QlFVTkJPMEZCUTBFN1FVRkRRVHRCUVVOQk8wRkJRMEU3UVVGRFFUdEJRVU5CTzBGQlEwRTdRVUZEUVR0QlFVTkJPMEZCUTBFN1FVRkRRVHRCUVVOQk8wRkJRMEU3UVVGRFFUdEJRVU5CTzBGQlEwRTdRVUZEUVR0QlFVTkJPMEZCUTBFN1FVRkRRVHRCUVVOQk8wRkJRMEU3UVVGRFFUdEJRVU5CTzBGQlEwRTdRVUZEUVR0QlFVTkJPMEZCUTBFN1FVRkRRVHRCUVVOQk8wRkJRMEU3UVVGRFFUdEJRVU5CTzBGQlEwRTdRVUZEUVR0QlFVTkJPMEZCUTBFN1FVRkRRVHRCUVVOQk8wRkJRMEU3UVVGRFFUdEJRVU5CTzBGQlEwRTdRVUZEUVR0QlFVTkJPMEZCUTBFN1FVRkRRVHRCUVVOQk8wRkJRMEU3UVVGRFFUdEJRVU5CTzBGQlEwRTdRVUZEUVR0QlFVTkJPMEZCUTBFN1FVRkRRVHRCUVVOQk8wRkJRMEU3UVVGRFFUdEJRVU5CTzBGQlEwRTdRVUZEUVR0QlFVTkJPMEZCUTBFN1FVRkRRVHRCUVVOQk8wRkJRMEU3UVVGRFFUdEJRVU5CTzBGQlEwRTdRVUZEUVR0QlFVTkJPMEZCUTBFN1FVRkRRVHRCUVVOQk8wRkJRMEU3UVVGRFFUdEJRVU5CTzBGQlEwRTdRVUZEUVR0QlFVTkJPMEZCUTBFN1FVRkRRVHRCUVVOQk8wRkJRMEU3UVVGRFFUdEJRVU5CTzBGQlEwRTdRVUZEUVR0QlFVTkJPMEZCUTBFN1FVRkRRVHRCUVVOQk8wRkJRMEU3UVVGRFFUdEJRVU5CTzBGQlEwRTdRVUZEUVR0QlFVTkJPMEZCUTBFN1FVRkRRVHRCUVVOQk8wRkJRMEU3UVVGRFFUdEJRVU5CTzBGQlEwRTdRVUZEUVR0QlFVTkJPMEZCUTBFN1FVRkRRVHRCUVVOQk8wRkJRMEU3UVVGRFFUdEJRVU5CTzBGQlEwRTdRVUZEUVR0QlFVTkJPMEZCUTBFN1FVRkRRVHRCUVVOQk8wRkJRMEU3UVVGRFFUdEJRVU5CTzBGQlEwRTdRVUZEUVR0QlFVTkJPMEZCUTBFN1FVRkRRVHRCUVVOQk8wRkJRMEU3UVVGRFFUdEJRVU5CTzBGQlEwRTdRVUZEUVR0QlFVTkJPMEZCUTBFN1FVRkRRVHRCUVVOQk8wRkJRMEU3UVVGRFFUdEJRVU5CTzBGQlEwRTdRVUZEUVR0QlFVTkJPMEZCUTBFN1FVRkRRVHRCUVVOQk8wRkJRMEU3UVVGRFFUdEJRVU5CTzBGQlEwRTdRVUZEUVR0QlFVTkJPMEZCUTBFN1FVRkRRVHRCUVVOQk8wRkJRMEU3UVVGRFFUdEJRVU5CTzBGQlEwRTdRVUZEUVR0QlFVTkJPMEZCUTBFN1FVRkRRVHRCUVVOQk8wRkJRMEU3UVVGRFFUdEJRVU5CTzBGQlEwRTdRVUZEUVR0QlFVTkJPMEZCUTBFN1FVRkRRVHRCUVVOQk8wRkJRMEU3UVVGRFFUdEJRVU5CTzBGQlEwRTdRVUZEUVR0QlFVTkJPMEZCUTBFN1FVRkRRVHRCUVVOQk8wRkJRMEU3UVVGRFFUdEJRVU5CTzBGQlEwRTdRVUZEUVR0QlFVTkJPMEZCUTBFN1FVRkRRVHRCUVVOQk8wRkJRMEU3UVVGRFFUdEJRVU5CTzBGQlEwRTdRVUZEUVR0QlFVTkJPMEZCUTBFN1FVRkRRVHRCUVVOQk8wRkJRMEU3UVVGRFFUdEJRVU5CTzBGQlEwRTdRVUZEUVR0QlFVTkJPMEZCUTBFN1FVRkRRVHRCUVVOQk8wRkJRMEU3UVVGRFFUdEJRVU5CTzBGQlEwRTdRVUZEUVR0QlFVTkJPMEZCUTBFN1FVRkRRVHRCUVVOQk8wRkJRMEU3UVVGRFFUdEJRVU5CTzBGQlEwRTdRVUZEUVR0QlFVTkJPMEZCUTBFN1FVRkRRVHRCUVVOQk8wRkJRMEU3UVVGRFFUdEJRVU5CTzBGQlEwRTdRVUZEUVR0QlFVTkJPMEZCUTBFN1FVRkRRVHRCUVVOQk8wRkJRMEU3UVVGRFFUdEJRVU5CTzBGQlEwRTdRVUZEUVR0QlFVTkJPMEZCUTBFN1FVRkRRVHRCUVVOQk8wRkJRMEU3UVVGRFFUdEJRVU5CTzBGQlEwRTdRVUZEUVR0QlFVTkJPMEZCUTBFN1FVRkRRVHRCUVVOQk8wRkJRMEU3UVVGRFFUdEJRVU5CTzBGQlEwRTdRVUZEUVR0QlFVTkJPMEZCUTBFN1FVRkRRVHRCUVVOQk8wRkJRMEU3UVVGRFFUdEJRVU5CTzBGQlEwRTdRVUZEUVR0QlFVTkJPMEZCUTBFN1FVRkRRVHRCUVVOQk8wRkJRMEU3UVVGRFFUdEJRVU5CTzBGQlEwRTdRVUZEUVR0QlFVTkJPMEZCUTBFN1FVRkRRVHRCUVVOQk8wRkJRMEU3UVVGRFFUdEJRVU5CTzBGQlEwRTdRVUZEUVR0QlFVTkJPMEZCUTBFN1FVRkRRVHRCUVVOQk8wRkJRMEU3UVVGRFFUdEJRVU5CTzBGQlEwRTdRVUZEUVR0QlFVTkJPMEZCUTBFN1FVRkRRVHRCUVVOQk8wRkJRMEU3UVVGRFFUdEJRVU5CTzBGQlEwRTdRVUZEUVR0QlFVTkJPMEZCUTBFN1FVRkRRVHRCUVVOQk8wRkJRMEU3UVVGRFFUdEJRVU5CTzBGQlEwRTdRVUZEUVR0QlFVTkJPMEZCUTBFN1FVRkRRVHRCUVVOQk8wRkJRMEU3UVVGRFFUdEJRVU5CTzBGQlEwRTdRVUZEUVR0QlFVTkJPMEZCUTBFN1FVRkRRVHRCUVVOQk8wRkJRMEU3UVVGRFFUdEJRVU5CTzBGQlEwRTdRVUZEUVR0QlFVTkJPMEZCUTBFN1FVRkRRVHRCUVVOQk8wRkJRMEU3UVVGRFFUdEJRVU5CTzBGQlEwRTdRVUZEUVR0QlFVTkJPMEZCUTBFN1FVRkRRVHRCUVVOQk8wRkJRMEU3UVVGRFFUdEJRVU5CTzBGQlEwRTdRVUZEUVR0QlFVTkJPMEZCUTBFN1FVRkRRVHRCUVVOQk8wRkJRMEU3UVVGRFFUdEJRVU5CTzBGQlEwRTdRVUZEUVR0QlFVTkJPMEZCUTBFN1FVRkRRVHRCUVVOQk8wRkJRMEU3UVVGRFFUdEJRVU5CTzBGQlEwRTdRVUZEUVR0QlFVTkJPMEZCUTBFN1FVRkRRVHRCUVVOQk8wRkJRMEU3UVVGRFFUdEJRVU5CTzBGQlEwRTdRVUZEUVR0QlFVTkJPMEZCUTBFN1FVRkRRVHRCUVVOQk8wRkJRMEU3UVVGRFFUdEJRVU5CTzBGQlEwRTdRVUZEUVR0QlFVTkJPMEZCUTBFN1FVRkRRVHRCUVVOQk8wRkJRMEU3UVVGRFFUdEJRVU5CTzBGQlEwRTdRVUZEUVR0QlFVTkJPMEZCUTBFN1FVRkRRVHRCUVVOQk8wRkJRMEU3UVVGRFFUdEJRVU5CTzBGQlEwRTdRVUZEUVR0QlFVTkJPMEZCUTBFN1FVRkRRVHRCUVVOQk8wRkJRMEU3UVVGRFFUdEJRVU5CTzBGQlEwRTdRVUZEUVR0QlFVTkJPMEZCUTBFN1FVRkRRVHRCUVVOQk8wRkJRMEU3UVVGRFFUdEJRVU5CTzBGQlEwRTdRVUZEUVR0QlFVTkJPMEZCUTBFN1FVRkRRVHRCUVVOQk8wRkJRMEU3UVVGRFFUdEJRVU5CTzBGQlEwRTdRVUZEUVR0QlFVTkJPMEZCUTBFN1FVRkRRVHRCUVVOQk8wRkJRMEU3UVVGRFFUdEJRVU5CTzBGQlEwRTdRVUZEUVR0QlFVTkJPMEZCUTBFN1FVRkRRVHRCUVVOQk8wRkJRMEU3UVVGRFFUdEJRVU5CTzBGQlEwRTdRVUZEUVR0QlFVTkJPMEZCUTBFN1FVRkRRVHRCUVVOQk8wRkJRMEU3UVVGRFFUdEJRVU5CTzBGQlEwRTdRVUZEUVR0QlFVTkJPMEZCUTBFN1FVRkRRVHRCUVVOQk8wRkJRMEU3UVVGRFFUdEJRVU5CTzBGQlEwRTdRVUZEUVR0QlFVTkJPMEZCUTBFN1FVRkRRVHRCUVVOQk8wRkJRMEU3UVVGRFFUdEJRVU5CTzBGQlEwRTdRVUZEUVR0QlFVTkJPMEZCUTBFN1FVRkRRVHRCUVVOQk8wRkJRMEU3UVVGRFFUdEJRVU5CTzBGQlEwRTdRVUZEUVR0QlFVTkJPMEZCUTBFN1FVRkRRVHRCUVVOQk8wRkJRMEU3UVVGRFFUdEJRVU5CTzBGQlEwRTdRVUZEUVR0QlFVTkJPMEZCUTBFN1FVRkRRVHRCUVVOQk8wRkJRMEU3UVVGRFFUdEJRVU5CTzBGQlEwRTdRVUZEUVR0QlFVTkJPMEZCUTBFN1FVRkRRVHRCUVVOQk8wRkJRMEU3UVVGRFFUdEJRVU5CTzBGQlEwRTdRVUZEUVR0QlFVTkJPMEZCUTBFN1FVRkRRVHRCUVVOQk8wRkJRMEU3UVVGRFFUdEJRVU5CTzBGQlEwRTdRVUZEUVR0QlFVTkJPMEZCUTBFN1FVRkRRVHRCUVVOQk8wRkJRMEU3UVVGRFFUdEJRVU5CTzBGQlEwRTdRVUZEUVR0QlFVTkJPMEZCUTBFN1FVRkRRVHRCUVVOQk8wRkJRMEU3UVVGRFFUdEJRVU5CTzBGQlEwRTdRVUZEUVR0QlFVTkJPMEZCUTBFN1FVRkRRVHRCUVVOQk8wRkJRMEU3UVVGRFFUdEJRVU5CTzBGQlEwRTdRVUZEUVR0QlFVTkJPMEZCUTBFN1FVRkRRVHRCUVVOQk8wRkJRMEU3UVVGRFFUdEJRVU5CTzBGQlEwRTdRVUZEUVR0QlFVTkJPMEZCUTBFN1FVRkRRVHRCUVVOQk8wRkJRMEU3UVVGRFFUdEJRVU5CTzBGQlEwRTdRVUZEUVR0QlFVTkJPMEZCUTBFN1FVRkRRVHRCUVVOQk8wRkJRMEU3UVVGRFFUdEJRVU5CTzBGQlEwRTdRVUZEUVR0QlFVTkJPMEZCUTBFN1FVRkRRVHRCUVVOQk8wRkJRMEU3UVVGRFFUdEJRVU5CTzBGQlEwRTdRVUZEUVR0QlFVTkJPMEZCUTBFN1FVRkRRVHRCUVVOQk8wRkJRMEU3UVVGRFFUdEJRVU5CTzBGQlEwRTdRVUZEUVR0QlFVTkJPMEZCUTBFN1FVRkRRVHRCUVVOQk8wRkJRMEU3UVVGRFFUdEJRVU5CTzBGQlEwRTdRVUZEUVR0QlFVTkJPMEZCUTBFN1FVRkRRVHRCUVVOQk8wRkJRMEU3UVVGRFFUdEJRVU5CTzBGQlEwRTdRVUZEUVR0QlFVTkJPMEZCUTBFN1FVRkRRVHRCUVVOQk8wRkJRMEU3UVVGRFFUdEJRVU5CTzBGQlEwRTdRVUZEUVR0QlFVTkJPMEZCUTBFN1FVRkRRVHRCUVVOQk8wRkJRMEU3UVVGRFFUdEJRVU5CTzBGQlEwRTdRVUZEUVR0QlFVTkJPMEZCUTBFN1FVRkRRVHRCUVVOQk8wRkJRMEU3UVVGRFFUdEJRVU5CTzBGQlEwRTdRVUZEUVR0QlFVTkJPMEZCUTBFN1FVRkRRVHRCUVVOQk8wRkJRMEU3UVVGRFFUdEJRVU5CTzBGQlEwRTdRVUZEUVR0QlFVTkJPMEZCUTBFN1FVRkRRVHRCUVVOQk8wRkJRMEU3UVVGRFFUdEJRVU5CTzBGQlEwRTdRVUZEUVR0QlFVTkJPMEZCUTBFN1FVRkRRVHRCUVVOQk8wRkJRMEU3UVVGRFFUdEJRVU5CTzBGQlEwRTdRVUZEUVR0QlFVTkJPMEZCUTBFN1FVRkRRVHRCUVVOQk8wRkJRMEU3UVVGRFFUdEJRVU5CTzBGQlEwRTdRVUZEUVR0QlFVTkJPMEZCUTBFN1FVRkRRVHRCUVVOQk8wRkJRMEU3UVVGRFFUdEJRVU5CTzBGQlEwRTdRVUZEUVR0QlFVTkJPMEZCUTBFN1FVRkRRVHRCUVVOQk8wRkJRMEU3UVVGRFFUdEJRVU5CTzBGQlEwRTdRVUZEUVR0QlFVTkJPMEZCUTBFN1FVRkRRVHRCUVVOQk8wRkJRMEU3UVVGRFFUdEJRVU5CTzBGQlEwRTdRVUZEUVR0QlFVTkJPMEZCUTBFN1FVRkRRVHRCUVVOQk8wRkJRMEU3UVVGRFFUdEJRVU5CT3pzN096czdPenM3T3pzN1FVTjBkRUpCTEVsQlFVMHNhMEpCUVd0Q0xFZEJRVWNzVDBGQlR5eERRVUZETEhGQ1FVRkVMRU5CUVd4RE96dEJRVVZCTEVsQlFVMHNUMEZCVHl4SFFVRkhMRkZCUVZFc1EwRkJReXhoUVVGVUxFTkJRWFZDTEU5QlFYWkNMRU5CUVdoQ08wRkJRMEVzU1VGQlRTeFZRVUZWTEVkQlFVY3NVVUZCVVN4RFFVRkRMR05CUVZRc1EwRkJkMElzV1VGQmVFSXNRMEZCYmtJN1FVRkRRU3hKUVVGTkxGRkJRVkVzUjBGQlJ5eFJRVUZSTEVOQlFVTXNZMEZCVkN4RFFVRjNRaXhWUVVGNFFpeERRVUZxUWp0QlFVTkJMRWxCUVUwc1RVRkJUU3hIUVVGSExGRkJRVkVzUTBGQlF5eGpRVUZVTEVOQlFYZENMRkZCUVhoQ0xFTkJRV1k3UVVGRFFTeEpRVUZOTEZWQlFWVXNSMEZCUnl4UlFVRlJMRU5CUVVNc1kwRkJWQ3hEUVVGM1FpeFpRVUY0UWl4RFFVRnVRanRCUVVOQkxFbEJRVTBzVDBGQlR5eEhRVUZITEZGQlFWRXNRMEZCUXl4alFVRlVMRU5CUVhkQ0xGTkJRWGhDTEVOQlFXaENPMEZCUTBFc1NVRkJUU3hUUVVGVExFZEJRVWNzVVVGQlVTeERRVUZETEdOQlFWUXNRMEZCZDBJc1YwRkJlRUlzUTBGQmJFSTdRVUZEUVN4SlFVRk5MRk5CUVZNc1IwRkJSeXhSUVVGUkxFTkJRVU1zWTBGQlZDeERRVUYzUWl4WFFVRjRRaXhEUVVGc1FqdEJRVU5CTEVsQlFVMHNVMEZCVXl4SFFVRkhMRkZCUVZFc1EwRkJReXhqUVVGVUxFTkJRWGRDTEZkQlFYaENMRU5CUVd4Q08wRkJRMEVzU1VGQlRTeFRRVUZUTEVkQlFVY3NVVUZCVVN4RFFVRkRMR05CUVZRc1EwRkJkMElzVjBGQmVFSXNRMEZCYkVJN1FVRkRRU3hKUVVGTkxGTkJRVk1zUjBGQlJ5eFJRVUZSTEVOQlFVTXNZMEZCVkN4RFFVRjNRaXhYUVVGNFFpeERRVUZzUWp0QlFVTkJMRWxCUVUwc1UwRkJVeXhIUVVGSExGRkJRVkVzUTBGQlF5eGpRVUZVTEVOQlFYZENMRmRCUVhoQ0xFTkJRV3hDTzBGQlEwRXNTVUZCVFN4VFFVRlRMRWRCUVVjc1VVRkJVU3hEUVVGRExHTkJRVlFzUTBGQmQwSXNWMEZCZUVJc1EwRkJiRUk3UVVGRFFTeEpRVUZOTEZWQlFWVXNSMEZCUnl4UlFVRlJMRU5CUVVNc1kwRkJWQ3hEUVVGM1FpeFpRVUY0UWl4RFFVRnVRanRCUVVOQkxFbEJRVTBzUzBGQlN5eEhRVUZITEZGQlFWRXNRMEZCUXl4alFVRlVMRU5CUVhkQ0xFOUJRWGhDTEVOQlFXUTdRVUZEUVN4SlFVRk5MRlZCUVZVc1IwRkJSeXhSUVVGUkxFTkJRVU1zWTBGQlZDeERRVUYzUWl4WlFVRjRRaXhEUVVGdVFqdEJRVU5CTEVsQlFVa3NUMEZCVHl4SFFVRkhMRU5CUVdRN1FVRkRRU3hKUVVGSkxFMUJRVTBzUjBGQlJ5eERRVUZpTzBGQlEwRXNTVUZCVFN4UlFVRlJMRWRCUVVjc1EwRkRaanRCUVVORkxFVkJRVUVzUjBGQlJ5eEZRVUZGTEcxQ1FVUlFPMEZCUlVVc1JVRkJRU3hSUVVGUkxFVkJRVVVzZDBKQlJsbzdRVUZIUlN4RlFVRkJMRWxCUVVrc1JVRkRSanRCUVVwS0xFTkJSR1VzUlVGUFpqdEJRVU5GTEVWQlFVRXNSMEZCUnl4RlFVRkZMRzFDUVVSUU8wRkJSVVVzUlVGQlFTeFJRVUZSTEVWQlFVVXNiVUpCUmxvN1FVRkhSU3hGUVVGQkxFbEJRVWtzUlVGRFJqdEJRVXBLTEVOQlVHVXNSVUZoWmp0QlFVTkZMRVZCUVVFc1IwRkJSeXhGUVVGRkxIRkNRVVJRTzBGQlJVVXNSVUZCUVN4UlFVRlJMRVZCUVVVc1ZVRkdXanRCUVVkRkxFVkJRVUVzU1VGQlNTeEZRVU5HTzBGQlNrb3NRMEZpWlN4RlFXMUNaanRCUVVORkxFVkJRVUVzUjBGQlJ5eEZRVUZGTERCQ1FVUlFPMEZCUlVVc1JVRkJRU3hSUVVGUkxFVkJRVVVzWlVGR1dqdEJRVWRGTEVWQlFVRXNTVUZCU1N4RlFVTkdPMEZCU2tvc1EwRnVRbVVzUlVGNVFtWTdRVUZEUlN4RlFVRkJMRWRCUVVjc1JVRkJSU3h2UWtGRVVEdEJRVVZGTEVWQlFVRXNVVUZCVVN4RlFVRkZMRk5CUmxvN1FVRkhSU3hGUVVGQkxFbEJRVWtzUlVGRFJqdEJRVXBLTEVOQmVrSmxMRVZCSzBKbU8wRkJRMFVzUlVGQlFTeEhRVUZITEVWQlFVVXNiVUpCUkZBN1FVRkZSU3hGUVVGQkxGRkJRVkVzUlVGQlJTeFJRVVphTzBGQlIwVXNSVUZCUVN4SlFVRkpMRVZCUTBZN1FVRktTaXhEUVM5Q1pTeEZRWEZEWmp0QlFVTkZMRVZCUVVFc1IwRkJSeXhGUVVGRkxIRkNRVVJRTzBGQlJVVXNSVUZCUVN4UlFVRlJMRVZCUVVVc1ZVRkdXanRCUVVkRkxFVkJRVUVzU1VGQlNTeEZRVU5HTzBGQlNrb3NRMEZ5UTJVc1JVRXlRMlk3UVVGRFJTeEZRVUZCTEVkQlFVY3NSVUZCUlN4clEwRkVVRHRCUVVWRkxFVkJRVUVzVVVGQlVTeEZRVUZGTEhWQ1FVWmFPMEZCUjBVc1JVRkJRU3hKUVVGSkxFVkJRMFk3UVVGS1NpeERRVE5EWlN4RlFXbEVaanRCUVVORkxFVkJRVUVzUjBGQlJ5eEZRVUZGTERSQ1FVUlFPMEZCUlVVc1JVRkJRU3hSUVVGUkxFVkJRVVVzYVVKQlJsbzdRVUZIUlN4RlFVRkJMRWxCUVVrc1JVRkRSanRCUVVwS0xFTkJha1JsTEVOQlFXcENPMEZCZVVSQkxGRkJRVkVzUTBGQlF5eG5Ra0ZCVkN4RFFVRXdRaXhSUVVFeFFpeEZRVUZ2UXl4WlFVRk5PMEZCUTNoRExFMUJRVWtzVFVGQlRTeERRVUZETEZkQlFWQXNSMEZCY1VJc1QwRkJUeXhEUVVGRExGbEJRV3BETEVWQlFTdERPMEZCUXpkRExFbEJRVUVzVDBGQlR5eERRVUZETEZOQlFWSXNRMEZCYTBJc1RVRkJiRUlzUTBGQmVVSXNUMEZCZWtJN1FVRkRSQ3hIUVVaRUxFMUJSVTg3UVVGRFRDeEpRVUZCTEU5QlFVOHNRMEZCUXl4VFFVRlNMRU5CUVd0Q0xFZEJRV3hDTEVOQlFYTkNMRTlCUVhSQ08wRkJRMFE3UVVGRFJpeERRVTVFT3p0QlFWRkJMRTFCUVUwc1EwRkJReXhQUVVGUUxFZEJRV2xDTEZWQlFVRXNRMEZCUXl4RlFVRkpPMEZCUTNCQ0xFVkJRVUVzUTBGQlF5eERRVUZETEdOQlFVWTdRVUZEUVN4RlFVRkJMRlZCUVZVc1EwRkJReXhUUVVGWUxFTkJRWEZDTEUxQlFYSkNMRU5CUVRSQ0xFMUJRVFZDTzBGQlEwUXNRMEZJUkRzN1FVRkxRU3hSUVVGUkxFTkJRVU1zVDBGQlZDeEhRVUZ0UWl4VlFVRkJMRU5CUVVNc1JVRkJTVHRCUVVOMFFpeEZRVUZCTEVOQlFVTXNRMEZCUXl4alFVRkdPMEZCUTBFc1JVRkJRU3hWUVVGVkxFTkJRVU1zVTBGQldDeERRVUZ4UWl4TlFVRnlRaXhEUVVFMFFpeE5RVUUxUWp0QlFVTkVMRU5CU0VRN08wRkJTMEVzVlVGQlZTeERRVUZETEU5QlFWZ3NSMEZCY1VJc1dVRkJUVHRCUVVONlFpeEZRVUZCTEZWQlFWVXNRMEZCUXl4VFFVRllMRU5CUVhGQ0xFMUJRWEpDTEVOQlFUUkNMRTFCUVRWQ08wRkJRMFFzUTBGR1JEczdRVUZKUVN4VFFVRlRMRU5CUVVNc1owSkJRVllzUTBGQk1rSXNUMEZCTTBJc1JVRkJiME1zVlVGQlFTeERRVUZETEVWQlFVazdRVUZEZGtNc1RVRkJTU3hOUVVGTkxFZEJRVWNzUTBGQlF5eERRVUZETEUxQlFXWTdRVUZEUVN4TlFVRk5MRWxCUVVrc1IwRkJSeXhSUVVGUkxFTkJRVU1zYzBKQlFWUXNRMEZCWjBNc2QwSkJRV2hETEVOQlFXSTdPMEZCUTBFc1RVRkJTU3hIUVVGSExITkNRVUZQTEVsQlFWQXNRMEZCVURzN1FVRkRRU3hOUVVGSkxFMUJRVTBzUTBGQlF5eFRRVUZRTEVOQlFXbENMRkZCUVdwQ0xFTkJRVEJDTEUxQlFURkNMRU5CUVVvc1JVRkJkVU03UVVGRGNrTXNTVUZCUVN4TlFVRk5MRU5CUVVNc1UwRkJVQ3hEUVVGcFFpeE5RVUZxUWl4RFFVRjNRaXhOUVVGNFFqdEJRVU5FTEVkQlJrUXNUVUZGVHp0QlFVTk1MRWxCUVVFc1IwRkJSeXhEUVVGRExFZEJRVW9zUTBGQlVTeFZRVUZCTEVOQlFVTTdRVUZCUVN4aFFVRkpMRU5CUVVNc1EwRkJReXhUUVVGR0xFTkJRVmtzVFVGQldpeERRVUZ0UWl4TlFVRnVRaXhEUVVGS08wRkJRVUVzUzBGQlZEdEJRVU5CTEVsQlFVRXNUVUZCVFN4RFFVRkRMRk5CUVZBc1EwRkJhVUlzVFVGQmFrSXNRMEZCZDBJc1RVRkJlRUk3UVVGRFJEdEJRVU5HTEVOQlZrUTdRVUZaUVN4TFFVRkxMRU5CUVVNc1owSkJRVTRzUTBGQmRVSXNWMEZCZGtJc1JVRkJiME1zVlVGQlFTeERRVUZETEVWQlFVazdRVUZEZGtNc1RVRkJUU3hOUVVGTkxFZEJRVWNzUTBGQlF5eERRVUZETEUxQlFXcENPMEZCUTBFc1RVRkJUU3hOUVVGTkxFZEJRVWNzUzBGQlN5eERRVUZETEZGQlFYSkNPenRCUVVOQkxFMUJRVWNzVFVGQlRTeERRVUZETEZOQlFWQXNRMEZCYVVJc1VVRkJha0lzUTBGQk1FSXNaVUZCTVVJc1EwRkJTQ3hGUVVFclF6dEJRVU0zUXl4VFFVRkxMRWxCUVVrc1EwRkJReXhIUVVGRExFTkJRVTRzUlVGQlV5eExRVUZrTEVWQlFYRkNMRXRCUVVzc1IwRkJSeXhOUVVGTkxFTkJRVU1zUTBGQlJDeERRVUZ1UXl4RlFVRjNReXhEUVVGRExFVkJRWHBETEVWQlFUWkRPMEZCUXpORExFMUJRVUVzUzBGQlN5eERRVUZETEZOQlFVNHNRMEZCWjBJc1RVRkJhRUlzUTBGQmRVSXNVVUZCZGtJN1FVRkRSRHM3UVVGRFJDeEpRVUZCTEUxQlFVMHNRMEZCUXl4VFFVRlFMRU5CUVdsQ0xFZEJRV3BDTEVOQlFYRkNMRkZCUVhKQ08wRkJRMFFzUjBGTVJDeE5RVXRQTzBGQlExSXNRMEZVUkRzN1FVRlhRU3hUUVVGVExFTkJRVU1zVDBGQlZpeEhRVUZ2UWl4WlFVRk5PMEZCUTNoQ0xFVkJRVUVzVTBGQlV5eERRVUZETEZOQlFWWXNRMEZCYjBJc1RVRkJjRUlzUTBGQk1rSXNUVUZCTTBJN1FVRkRRU3hGUVVGQkxGTkJRVk1zUTBGQlF5eFRRVUZXTEVOQlFXOUNMRTFCUVhCQ0xFTkJRVEpDTEUxQlFUTkNPMEZCUTBFc1JVRkJRU3hUUVVGVExFTkJRVU1zVTBGQlZpeERRVUZ2UWl4TlFVRndRaXhEUVVFeVFpeFJRVUV6UWp0QlFVTkJMRVZCUVVFc1UwRkJVeXhEUVVGRExGTkJRVllzUTBGQmIwSXNUVUZCY0VJc1EwRkJNa0lzVVVGQk0wSTdRVUZEUkN4RFFVeEVPenRCUVU5QkxGTkJRVk1zUTBGQlF5eFBRVUZXTEVkQlFXOUNMRmxCUVUwN1FVRkRlRUlzUlVGQlFTeFRRVUZUTEVOQlFVTXNVMEZCVml4RFFVRnZRaXhOUVVGd1FpeERRVUV5UWl4TlFVRXpRanRCUVVOQkxFVkJRVUVzVTBGQlV5eERRVUZETEZOQlFWWXNRMEZCYjBJc1RVRkJjRUlzUTBGQk1rSXNUVUZCTTBJN1FVRkRRU3hGUVVGQkxGTkJRVk1zUTBGQlF5eFRRVUZXTEVOQlFXOUNMRTFCUVhCQ0xFTkJRVEpDTEZGQlFUTkNPMEZCUTBFc1JVRkJRU3hUUVVGVExFTkJRVU1zVTBGQlZpeERRVUZ2UWl4TlFVRndRaXhEUVVFeVFpeFJRVUV6UWp0QlFVTkVMRU5CVEVRN08wRkJUMEVzVTBGQlV5eERRVUZETEU5QlFWWXNSMEZCYjBJc1dVRkJUVHRCUVVONFFpeEZRVUZCTEZWQlFWVXNRMEZCUXl4VFFVRllMRU5CUVhGQ0xFMUJRWEpDTEVOQlFUUkNMRTFCUVRWQ08wRkJRMEVzUlVGQlFTeFRRVUZUTEVOQlFVTXNVMEZCVml4RFFVRnZRaXhOUVVGd1FpeERRVUV5UWl4UlFVRXpRanRCUVVOQkxFVkJRVUVzVTBGQlV5eERRVUZETEZOQlFWWXNRMEZCYjBJc1RVRkJjRUlzUTBGQk1rSXNVVUZCTTBJN1FVRkRSQ3hEUVVwRU96dEJRVTFCTEZOQlFWTXNRMEZCUXl4UFFVRldMRWRCUVc5Q0xGbEJRVTA3UVVGRGVFSXNSVUZCUVN4VlFVRlZMRU5CUVVNc1UwRkJXQ3hEUVVGeFFpeE5RVUZ5UWl4RFFVRTBRaXhOUVVFMVFqdEJRVU5CTEVWQlFVRXNVMEZCVXl4RFFVRkRMRk5CUVZZc1EwRkJiMElzVFVGQmNFSXNRMEZCTWtJc1VVRkJNMEk3UVVGRFFTeEZRVUZCTEZOQlFWTXNRMEZCUXl4VFFVRldMRU5CUVc5Q0xFMUJRWEJDTEVOQlFUSkNMRkZCUVROQ08wRkJRMFFzUTBGS1JEczdRVUZOUVN4SlFVRk5MR05CUVdNc1IwRkJSeXhUUVVGcVFpeGpRVUZwUWl4RFFVRkJMRWxCUVVrc1JVRkJTVHRCUVVNM1FpeHRTa0ZGYVVRc1NVRkJTU3hEUVVGRExFZEJSblJFTEdkSVFVbHhReXhKUVVGSkxFTkJRVU1zVVVGS01VTXNjMFJCUzJkRExFbEJRVWtzUTBGQlF5eEpRVXh5UXp0QlFWTkVMRU5CVmtRN08wRkJXVUVzU1VGQlNTeGhRVUZoTEVkQlFVY3NVMEZCYUVJc1lVRkJaMElzUTBGQlFTeFpRVUZaTEVWQlFVazdRVUZEYkVNc1RVRkJUU3hSUVVGUkxFZEJRVWNzV1VGQldTeERRVUZETEVkQlFXSXNRMEZCYVVJc1ZVRkJRU3hQUVVGUE8wRkJRVUVzVjBGQlNTeGpRVUZqTEVOQlFVTXNUMEZCUkN4RFFVRnNRanRCUVVGQkxFZEJRWGhDTEVOQlFXcENPMEZCUTBFc1JVRkJRU3hSUVVGUkxFTkJRVU1zWTBGQlZDeERRVUYzUWl4blFrRkJlRUlzUlVGQk1FTXNVMEZCTVVNc1IwRkJjMFFzVVVGQlVTeERRVUZETEVsQlFWUXNRMEZCWXl4RlFVRmtMRU5CUVhSRU8wRkJRMFFzUTBGSVJEczdRVUZMUVN4UFFVRlBMRU5CUVVNc1QwRkJVaXhIUVVGclFpeFZRVUZCTEVOQlFVTXNSVUZCU1R0QlFVTnlRaXhGUVVGQkxFTkJRVU1zUTBGQlF5eGpRVUZHTzBGQlEwRXNSVUZCUVN4UFFVRlBMRWxCUVVrc1RVRkJXRHRCUVVOQkxFVkJRVUVzWVVGQllTeERRVUZETEZGQlFWRXNRMEZCUXl4TFFVRlVMRU5CUVdVc1EwRkJaaXhGUVVGclFpeFBRVUZzUWl4RFFVRkVMRU5CUVdJN1FVRkRSQ3hEUVVwRU96dEJRVTFCTEUxQlFVMHNRMEZCUXl4blFrRkJVQ3hEUVVGM1FpeHJRa0ZCZUVJc1JVRkJORU1zV1VGQlRUdEJRVU5vUkN4TlFVRk5MRmxCUVZrc1IwRkJSeXhUUVVGbUxGbEJRV1U3UVVGQlFUdEJRVUZCTzBGQlFVRTdRVUZCUVR0QlFVRkJMREJDUVVOWUxFbEJSRmM3UVVGQlFTdzBRMEZGV2l4UlFVRlJMRU5CUVVNc1pVRkJWQ3hEUVVGNVFpeFhRVUY2UWl4SFFVRjFReXhIUVVZelFpeDFRa0ZMV2l4UlFVRlJMRU5CUVVNc1pVRkJWQ3hEUVVGNVFpeFhRVUY2UWl4SFFVRjFReXhIUVV3elFqdEJRVUZCT3p0QlFVRkJPMEZCUjJZc1dVRkJRU3hQUVVGUExFZEJRVWNzUTBGQlZqdEJRVWhsT3p0QlFVRkJPMEZCVFdZc1dVRkJRU3hQUVVGUExFZEJRVWNzUTBGQlZqdEJRVU5CTEZsQlFVRXNUVUZCVFN4SFFVRkhMRU5CUVZRN1FVRlFaVHM3UVVGQlFUdEJRVlZtTEZsQlFVRXNUMEZCVHl4SFFVRkhMRU5CUVZZN1FVRkRRU3haUVVGQkxFMUJRVTBzUjBGQlJ5eERRVUZVTzBGQldHVTdPMEZCUVVFN1FVRkJRVHRCUVVGQk8wRkJRVUU3UVVGQlFUdEJRVUZCTzBGQlFVRXNSMEZCY2tJN08wRkJaVUVzUlVGQlFTeFpRVUZaTzBGQlExb3NSVUZCUVN4aFFVRmhMRU5CUVVNc1VVRkJVU3hEUVVGRExFdEJRVlFzUTBGQlpTeERRVUZtTEVWQlFXdENMRTlCUVd4Q0xFTkJRVVFzUTBGQllqdEJRVU5FTEVOQmJFSkVJaXdpWm1sc1pTSTZJbWRsYm1WeVlYUmxaQzVxY3lJc0luTnZkWEpqWlZKdmIzUWlPaUlpTENKemIzVnlZMlZ6UTI5dWRHVnVkQ0k2V3lJb1puVnVZM1JwYjI0b0tYdG1kVzVqZEdsdmJpQnlLR1VzYml4MEtYdG1kVzVqZEdsdmJpQnZLR2tzWmlsN2FXWW9JVzViYVYwcGUybG1LQ0ZsVzJsZEtYdDJZWElnWXoxY0ltWjFibU4wYVc5dVhDSTlQWFI1Y0dWdlppQnlaWEYxYVhKbEppWnlaWEYxYVhKbE8ybG1LQ0ZtSmlaaktYSmxkSFZ5YmlCaktHa3NJVEFwTzJsbUtIVXBjbVYwZFhKdUlIVW9hU3doTUNrN2RtRnlJR0U5Ym1WM0lFVnljbTl5S0Z3aVEyRnVibTkwSUdacGJtUWdiVzlrZFd4bElDZGNJaXRwSzF3aUoxd2lLVHQwYUhKdmR5QmhMbU52WkdVOVhDSk5UMFJWVEVWZlRrOVVYMFpQVlU1RVhDSXNZWDEyWVhJZ2NEMXVXMmxkUFh0bGVIQnZjblJ6T250OWZUdGxXMmxkV3pCZExtTmhiR3dvY0M1bGVIQnZjblJ6TEdaMWJtTjBhVzl1S0hJcGUzWmhjaUJ1UFdWYmFWMWJNVjFiY2wwN2NtVjBkWEp1SUc4b2JueDhjaWw5TEhBc2NDNWxlSEJ2Y25SekxISXNaU3h1TEhRcGZYSmxkSFZ5YmlCdVcybGRMbVY0Y0c5eWRITjlabTl5S0haaGNpQjFQVndpWm5WdVkzUnBiMjVjSWowOWRIbHdaVzltSUhKbGNYVnBjbVVtSm5KbGNYVnBjbVVzYVQwd08yazhkQzVzWlc1bmRHZzdhU3NyS1c4b2RGdHBYU2s3Y21WMGRYSnVJRzk5Y21WMGRYSnVJSEo5S1NncElpd2lMeW9xWEc0Z0tpQkRiM0I1Y21sbmFIUWdLR01wSURJd01UUXRjSEpsYzJWdWRDd2dSbUZqWldKdmIyc3NJRWx1WXk1Y2JpQXFYRzRnS2lCVWFHbHpJSE52ZFhKalpTQmpiMlJsSUdseklHeHBZMlZ1YzJWa0lIVnVaR1Z5SUhSb1pTQk5TVlFnYkdsalpXNXpaU0JtYjNWdVpDQnBiaUIwYUdWY2JpQXFJRXhKUTBWT1UwVWdabWxzWlNCcGJpQjBhR1VnY205dmRDQmthWEpsWTNSdmNua2diMllnZEdocGN5QnpiM1Z5WTJVZ2RISmxaUzVjYmlBcUwxeHVYRzUyWVhJZ2NuVnVkR2x0WlNBOUlDaG1kVzVqZEdsdmJpQW9aWGh3YjNKMGN5a2dlMXh1SUNCY0luVnpaU0J6ZEhKcFkzUmNJanRjYmx4dUlDQjJZWElnVDNBZ1BTQlBZbXBsWTNRdWNISnZkRzkwZVhCbE8xeHVJQ0IyWVhJZ2FHRnpUM2R1SUQwZ1QzQXVhR0Z6VDNkdVVISnZjR1Z5ZEhrN1hHNGdJSFpoY2lCMWJtUmxabWx1WldRN0lDOHZJRTF2Y21VZ1kyOXRjSEpsYzNOcFlteGxJSFJvWVc0Z2RtOXBaQ0F3TGx4dUlDQjJZWElnSkZONWJXSnZiQ0E5SUhSNWNHVnZaaUJUZVcxaWIyd2dQVDA5SUZ3aVpuVnVZM1JwYjI1Y0lpQS9JRk41YldKdmJDQTZJSHQ5TzF4dUlDQjJZWElnYVhSbGNtRjBiM0pUZVcxaWIyd2dQU0FrVTNsdFltOXNMbWwwWlhKaGRHOXlJSHg4SUZ3aVFFQnBkR1Z5WVhSdmNsd2lPMXh1SUNCMllYSWdZWE41Ym1OSmRHVnlZWFJ2Y2xONWJXSnZiQ0E5SUNSVGVXMWliMnd1WVhONWJtTkpkR1Z5WVhSdmNpQjhmQ0JjSWtCQVlYTjVibU5KZEdWeVlYUnZjbHdpTzF4dUlDQjJZWElnZEc5VGRISnBibWRVWVdkVGVXMWliMndnUFNBa1UzbHRZbTlzTG5SdlUzUnlhVzVuVkdGbklIeDhJRndpUUVCMGIxTjBjbWx1WjFSaFoxd2lPMXh1WEc0Z0lHWjFibU4wYVc5dUlIZHlZWEFvYVc1dVpYSkdiaXdnYjNWMFpYSkdiaXdnYzJWc1ppd2dkSEo1VEc5amMweHBjM1FwSUh0Y2JpQWdJQ0F2THlCSlppQnZkWFJsY2tadUlIQnliM1pwWkdWa0lHRnVaQ0J2ZFhSbGNrWnVMbkJ5YjNSdmRIbHdaU0JwY3lCaElFZGxibVZ5WVhSdmNpd2dkR2hsYmlCdmRYUmxja1p1TG5CeWIzUnZkSGx3WlNCcGJuTjBZVzVqWlc5bUlFZGxibVZ5WVhSdmNpNWNiaUFnSUNCMllYSWdjSEp2ZEc5SFpXNWxjbUYwYjNJZ1BTQnZkWFJsY2tadUlDWW1JRzkxZEdWeVJtNHVjSEp2ZEc5MGVYQmxJR2x1YzNSaGJtTmxiMllnUjJWdVpYSmhkRzl5SUQ4Z2IzVjBaWEpHYmlBNklFZGxibVZ5WVhSdmNqdGNiaUFnSUNCMllYSWdaMlZ1WlhKaGRHOXlJRDBnVDJKcVpXTjBMbU55WldGMFpTaHdjbTkwYjBkbGJtVnlZWFJ2Y2k1d2NtOTBiM1I1Y0dVcE8xeHVJQ0FnSUhaaGNpQmpiMjUwWlhoMElEMGdibVYzSUVOdmJuUmxlSFFvZEhKNVRHOWpjMHhwYzNRZ2ZId2dXMTBwTzF4dVhHNGdJQ0FnTHk4Z1ZHaGxJQzVmYVc1MmIydGxJRzFsZEdodlpDQjFibWxtYVdWeklIUm9aU0JwYlhCc1pXMWxiblJoZEdsdmJuTWdiMllnZEdobElDNXVaWGgwTEZ4dUlDQWdJQzh2SUM1MGFISnZkeXdnWVc1a0lDNXlaWFIxY200Z2JXVjBhRzlrY3k1Y2JpQWdJQ0JuWlc1bGNtRjBiM0l1WDJsdWRtOXJaU0E5SUcxaGEyVkpiblp2YTJWTlpYUm9iMlFvYVc1dVpYSkdiaXdnYzJWc1ppd2dZMjl1ZEdWNGRDazdYRzVjYmlBZ0lDQnlaWFIxY200Z1oyVnVaWEpoZEc5eU8xeHVJQ0I5WEc0Z0lHVjRjRzl5ZEhNdWQzSmhjQ0E5SUhkeVlYQTdYRzVjYmlBZ0x5OGdWSEo1TDJOaGRHTm9JR2hsYkhCbGNpQjBieUJ0YVc1cGJXbDZaU0JrWlc5d2RHbHRhWHBoZEdsdmJuTXVJRkpsZEhWeWJuTWdZU0JqYjIxd2JHVjBhVzl1WEc0Z0lDOHZJSEpsWTI5eVpDQnNhV3RsSUdOdmJuUmxlSFF1ZEhKNVJXNTBjbWxsYzF0cFhTNWpiMjF3YkdWMGFXOXVMaUJVYUdseklHbHVkR1Z5Wm1GalpTQmpiM1ZzWkZ4dUlDQXZMeUJvWVhabElHSmxaVzRnS0dGdVpDQjNZWE1nY0hKbGRtbHZkWE5zZVNrZ1pHVnphV2R1WldRZ2RHOGdkR0ZyWlNCaElHTnNiM04xY21VZ2RHOGdZbVZjYmlBZ0x5OGdhVzUyYjJ0bFpDQjNhWFJvYjNWMElHRnlaM1Z0Wlc1MGN5d2dZblYwSUdsdUlHRnNiQ0IwYUdVZ1kyRnpaWE1nZDJVZ1kyRnlaU0JoWW05MWRDQjNaVnh1SUNBdkx5QmhiSEpsWVdSNUlHaGhkbVVnWVc0Z1pYaHBjM1JwYm1jZ2JXVjBhRzlrSUhkbElIZGhiblFnZEc4Z1kyRnNiQ3dnYzI4Z2RHaGxjbVVuY3lCdWJ5QnVaV1ZrWEc0Z0lDOHZJSFJ2SUdOeVpXRjBaU0JoSUc1bGR5Qm1kVzVqZEdsdmJpQnZZbXBsWTNRdUlGZGxJR05oYmlCbGRtVnVJR2RsZENCaGQyRjVJSGRwZEdnZ1lYTnpkVzFwYm1kY2JpQWdMeThnZEdobElHMWxkR2h2WkNCMFlXdGxjeUJsZUdGamRHeDVJRzl1WlNCaGNtZDFiV1Z1ZEN3Z2MybHVZMlVnZEdoaGRDQm9ZWEJ3Wlc1eklIUnZJR0psSUhSeWRXVmNiaUFnTHk4Z2FXNGdaWFpsY25rZ1kyRnpaU3dnYzI4Z2QyVWdaRzl1SjNRZ2FHRjJaU0IwYnlCMGIzVmphQ0IwYUdVZ1lYSm5kVzFsYm5SeklHOWlhbVZqZEM0Z1ZHaGxYRzRnSUM4dklHOXViSGtnWVdSa2FYUnBiMjVoYkNCaGJHeHZZMkYwYVc5dUlISmxjWFZwY21Wa0lHbHpJSFJvWlNCamIyMXdiR1YwYVc5dUlISmxZMjl5WkN3Z2QyaHBZMmhjYmlBZ0x5OGdhR0Z6SUdFZ2MzUmhZbXhsSUhOb1lYQmxJR0Z1WkNCemJ5Qm9iM0JsWm5Wc2JIa2djMmh2ZFd4a0lHSmxJR05vWldGd0lIUnZJR0ZzYkc5allYUmxMbHh1SUNCbWRXNWpkR2x2YmlCMGNubERZWFJqYUNobWJpd2diMkpxTENCaGNtY3BJSHRjYmlBZ0lDQjBjbmtnZTF4dUlDQWdJQ0FnY21WMGRYSnVJSHNnZEhsd1pUb2dYQ0p1YjNKdFlXeGNJaXdnWVhKbk9pQm1iaTVqWVd4c0tHOWlhaXdnWVhKbktTQjlPMXh1SUNBZ0lIMGdZMkYwWTJnZ0tHVnljaWtnZTF4dUlDQWdJQ0FnY21WMGRYSnVJSHNnZEhsd1pUb2dYQ0owYUhKdmQxd2lMQ0JoY21jNklHVnljaUI5TzF4dUlDQWdJSDFjYmlBZ2ZWeHVYRzRnSUhaaGNpQkhaVzVUZEdGMFpWTjFjM0JsYm1SbFpGTjBZWEowSUQwZ1hDSnpkWE53Wlc1a1pXUlRkR0Z5ZEZ3aU8xeHVJQ0IyWVhJZ1IyVnVVM1JoZEdWVGRYTndaVzVrWldSWmFXVnNaQ0E5SUZ3aWMzVnpjR1Z1WkdWa1dXbGxiR1JjSWp0Y2JpQWdkbUZ5SUVkbGJsTjBZWFJsUlhobFkzVjBhVzVuSUQwZ1hDSmxlR1ZqZFhScGJtZGNJanRjYmlBZ2RtRnlJRWRsYmxOMFlYUmxRMjl0Y0d4bGRHVmtJRDBnWENKamIyMXdiR1YwWldSY0lqdGNibHh1SUNBdkx5QlNaWFIxY201cGJtY2dkR2hwY3lCdlltcGxZM1FnWm5KdmJTQjBhR1VnYVc1dVpYSkdiaUJvWVhNZ2RHaGxJSE5oYldVZ1pXWm1aV04wSUdGelhHNGdJQzh2SUdKeVpXRnJhVzVuSUc5MWRDQnZaaUIwYUdVZ1pHbHpjR0YwWTJnZ2MzZHBkR05vSUhOMFlYUmxiV1Z1ZEM1Y2JpQWdkbUZ5SUVOdmJuUnBiblZsVTJWdWRHbHVaV3dnUFNCN2ZUdGNibHh1SUNBdkx5QkVkVzF0ZVNCamIyNXpkSEoxWTNSdmNpQm1kVzVqZEdsdmJuTWdkR2hoZENCM1pTQjFjMlVnWVhNZ2RHaGxJQzVqYjI1emRISjFZM1J2Y2lCaGJtUmNiaUFnTHk4Z0xtTnZibk4wY25WamRHOXlMbkJ5YjNSdmRIbHdaU0J3Y205d1pYSjBhV1Z6SUdadmNpQm1kVzVqZEdsdmJuTWdkR2hoZENCeVpYUjFjbTRnUjJWdVpYSmhkRzl5WEc0Z0lDOHZJRzlpYW1WamRITXVJRVp2Y2lCbWRXeHNJSE53WldNZ1kyOXRjR3hwWVc1alpTd2dlVzkxSUcxaGVTQjNhWE5vSUhSdklHTnZibVpwWjNWeVpTQjViM1Z5WEc0Z0lDOHZJRzFwYm1sbWFXVnlJRzV2ZENCMGJ5QnRZVzVuYkdVZ2RHaGxJRzVoYldWeklHOW1JSFJvWlhObElIUjNieUJtZFc1amRHbHZibk11WEc0Z0lHWjFibU4wYVc5dUlFZGxibVZ5WVhSdmNpZ3BJSHQ5WEc0Z0lHWjFibU4wYVc5dUlFZGxibVZ5WVhSdmNrWjFibU4wYVc5dUtDa2dlMzFjYmlBZ1puVnVZM1JwYjI0Z1IyVnVaWEpoZEc5eVJuVnVZM1JwYjI1UWNtOTBiM1I1Y0dVb0tTQjdmVnh1WEc0Z0lDOHZJRlJvYVhNZ2FYTWdZU0J3YjJ4NVptbHNiQ0JtYjNJZ0pVbDBaWEpoZEc5eVVISnZkRzkwZVhCbEpTQm1iM0lnWlc1MmFYSnZibTFsYm5SeklIUm9ZWFJjYmlBZ0x5OGdaRzl1SjNRZ2JtRjBhWFpsYkhrZ2MzVndjRzl5ZENCcGRDNWNiaUFnZG1GeUlFbDBaWEpoZEc5eVVISnZkRzkwZVhCbElEMGdlMzA3WEc0Z0lFbDBaWEpoZEc5eVVISnZkRzkwZVhCbFcybDBaWEpoZEc5eVUzbHRZbTlzWFNBOUlHWjFibU4wYVc5dUlDZ3BJSHRjYmlBZ0lDQnlaWFIxY200Z2RHaHBjenRjYmlBZ2ZUdGNibHh1SUNCMllYSWdaMlYwVUhKdmRHOGdQU0JQWW1wbFkzUXVaMlYwVUhKdmRHOTBlWEJsVDJZN1hHNGdJSFpoY2lCT1lYUnBkbVZKZEdWeVlYUnZjbEJ5YjNSdmRIbHdaU0E5SUdkbGRGQnliM1J2SUNZbUlHZGxkRkJ5YjNSdktHZGxkRkJ5YjNSdktIWmhiSFZsY3loYlhTa3BLVHRjYmlBZ2FXWWdLRTVoZEdsMlpVbDBaWEpoZEc5eVVISnZkRzkwZVhCbElDWW1YRzRnSUNBZ0lDQk9ZWFJwZG1WSmRHVnlZWFJ2Y2xCeWIzUnZkSGx3WlNBaFBUMGdUM0FnSmlaY2JpQWdJQ0FnSUdoaGMwOTNiaTVqWVd4c0tFNWhkR2wyWlVsMFpYSmhkRzl5VUhKdmRHOTBlWEJsTENCcGRHVnlZWFJ2Y2xONWJXSnZiQ2twSUh0Y2JpQWdJQ0F2THlCVWFHbHpJR1Z1ZG1seWIyNXRaVzUwSUdoaGN5QmhJRzVoZEdsMlpTQWxTWFJsY21GMGIzSlFjbTkwYjNSNWNHVWxPeUIxYzJVZ2FYUWdhVzV6ZEdWaFpGeHVJQ0FnSUM4dklHOW1JSFJvWlNCd2IyeDVabWxzYkM1Y2JpQWdJQ0JKZEdWeVlYUnZjbEJ5YjNSdmRIbHdaU0E5SUU1aGRHbDJaVWwwWlhKaGRHOXlVSEp2ZEc5MGVYQmxPMXh1SUNCOVhHNWNiaUFnZG1GeUlFZHdJRDBnUjJWdVpYSmhkRzl5Um5WdVkzUnBiMjVRY205MGIzUjVjR1V1Y0hKdmRHOTBlWEJsSUQxY2JpQWdJQ0JIWlc1bGNtRjBiM0l1Y0hKdmRHOTBlWEJsSUQwZ1QySnFaV04wTG1OeVpXRjBaU2hKZEdWeVlYUnZjbEJ5YjNSdmRIbHdaU2s3WEc0Z0lFZGxibVZ5WVhSdmNrWjFibU4wYVc5dUxuQnliM1J2ZEhsd1pTQTlJRWR3TG1OdmJuTjBjblZqZEc5eUlEMGdSMlZ1WlhKaGRHOXlSblZ1WTNScGIyNVFjbTkwYjNSNWNHVTdYRzRnSUVkbGJtVnlZWFJ2Y2taMWJtTjBhVzl1VUhKdmRHOTBlWEJsTG1OdmJuTjBjblZqZEc5eUlEMGdSMlZ1WlhKaGRHOXlSblZ1WTNScGIyNDdYRzRnSUVkbGJtVnlZWFJ2Y2taMWJtTjBhVzl1VUhKdmRHOTBlWEJsVzNSdlUzUnlhVzVuVkdGblUzbHRZbTlzWFNBOVhHNGdJQ0FnUjJWdVpYSmhkRzl5Um5WdVkzUnBiMjR1WkdsemNHeGhlVTVoYldVZ1BTQmNJa2RsYm1WeVlYUnZja1oxYm1OMGFXOXVYQ0k3WEc1Y2JpQWdMeThnU0dWc2NHVnlJR1p2Y2lCa1pXWnBibWx1WnlCMGFHVWdMbTVsZUhRc0lDNTBhSEp2ZHl3Z1lXNWtJQzV5WlhSMWNtNGdiV1YwYUc5a2N5QnZaaUIwYUdWY2JpQWdMeThnU1hSbGNtRjBiM0lnYVc1MFpYSm1ZV05sSUdsdUlIUmxjbTF6SUc5bUlHRWdjMmx1WjJ4bElDNWZhVzUyYjJ0bElHMWxkR2h2WkM1Y2JpQWdablZ1WTNScGIyNGdaR1ZtYVc1bFNYUmxjbUYwYjNKTlpYUm9iMlJ6S0hCeWIzUnZkSGx3WlNrZ2UxeHVJQ0FnSUZ0Y0ltNWxlSFJjSWl3Z1hDSjBhSEp2ZDF3aUxDQmNJbkpsZEhWeWJsd2lYUzVtYjNKRllXTm9LR1oxYm1OMGFXOXVLRzFsZEdodlpDa2dlMXh1SUNBZ0lDQWdjSEp2ZEc5MGVYQmxXMjFsZEdodlpGMGdQU0JtZFc1amRHbHZiaWhoY21jcElIdGNiaUFnSUNBZ0lDQWdjbVYwZFhKdUlIUm9hWE11WDJsdWRtOXJaU2h0WlhSb2IyUXNJR0Z5WnlrN1hHNGdJQ0FnSUNCOU8xeHVJQ0FnSUgwcE8xeHVJQ0I5WEc1Y2JpQWdaWGh3YjNKMGN5NXBjMGRsYm1WeVlYUnZja1oxYm1OMGFXOXVJRDBnWm5WdVkzUnBiMjRvWjJWdVJuVnVLU0I3WEc0Z0lDQWdkbUZ5SUdOMGIzSWdQU0IwZVhCbGIyWWdaMlZ1Um5WdUlEMDlQU0JjSW1aMWJtTjBhVzl1WENJZ0ppWWdaMlZ1Um5WdUxtTnZibk4wY25WamRHOXlPMXh1SUNBZ0lISmxkSFZ5YmlCamRHOXlYRzRnSUNBZ0lDQS9JR04wYjNJZ1BUMDlJRWRsYm1WeVlYUnZja1oxYm1OMGFXOXVJSHg4WEc0Z0lDQWdJQ0FnSUM4dklFWnZjaUIwYUdVZ2JtRjBhWFpsSUVkbGJtVnlZWFJ2Y2taMWJtTjBhVzl1SUdOdmJuTjBjblZqZEc5eUxDQjBhR1VnWW1WemRDQjNaU0JqWVc1Y2JpQWdJQ0FnSUNBZ0x5OGdaRzhnYVhNZ2RHOGdZMmhsWTJzZ2FYUnpJQzV1WVcxbElIQnliM0JsY25SNUxseHVJQ0FnSUNBZ0lDQW9ZM1J2Y2k1a2FYTndiR0Y1VG1GdFpTQjhmQ0JqZEc5eUxtNWhiV1VwSUQwOVBTQmNJa2RsYm1WeVlYUnZja1oxYm1OMGFXOXVYQ0pjYmlBZ0lDQWdJRG9nWm1Gc2MyVTdYRzRnSUgwN1hHNWNiaUFnWlhod2IzSjBjeTV0WVhKcklEMGdablZ1WTNScGIyNG9aMlZ1Um5WdUtTQjdYRzRnSUNBZ2FXWWdLRTlpYW1WamRDNXpaWFJRY205MGIzUjVjR1ZQWmlrZ2UxeHVJQ0FnSUNBZ1QySnFaV04wTG5ObGRGQnliM1J2ZEhsd1pVOW1LR2RsYmtaMWJpd2dSMlZ1WlhKaGRHOXlSblZ1WTNScGIyNVFjbTkwYjNSNWNHVXBPMXh1SUNBZ0lIMGdaV3h6WlNCN1hHNGdJQ0FnSUNCblpXNUdkVzR1WDE5d2NtOTBiMTlmSUQwZ1IyVnVaWEpoZEc5eVJuVnVZM1JwYjI1UWNtOTBiM1I1Y0dVN1hHNGdJQ0FnSUNCcFppQW9JU2gwYjFOMGNtbHVaMVJoWjFONWJXSnZiQ0JwYmlCblpXNUdkVzRwS1NCN1hHNGdJQ0FnSUNBZ0lHZGxia1oxYmx0MGIxTjBjbWx1WjFSaFoxTjViV0p2YkYwZ1BTQmNJa2RsYm1WeVlYUnZja1oxYm1OMGFXOXVYQ0k3WEc0Z0lDQWdJQ0I5WEc0Z0lDQWdmVnh1SUNBZ0lHZGxia1oxYmk1d2NtOTBiM1I1Y0dVZ1BTQlBZbXBsWTNRdVkzSmxZWFJsS0Vkd0tUdGNiaUFnSUNCeVpYUjFjbTRnWjJWdVJuVnVPMXh1SUNCOU8xeHVYRzRnSUM4dklGZHBkR2hwYmlCMGFHVWdZbTlrZVNCdlppQmhibmtnWVhONWJtTWdablZ1WTNScGIyNHNJR0JoZDJGcGRDQjRZQ0JwY3lCMGNtRnVjMlp2Y20xbFpDQjBiMXh1SUNBdkx5QmdlV2xsYkdRZ2NtVm5aVzVsY21GMGIzSlNkVzUwYVcxbExtRjNjbUZ3S0hncFlDd2djMjhnZEdoaGRDQjBhR1VnY25WdWRHbHRaU0JqWVc0Z2RHVnpkRnh1SUNBdkx5QmdhR0Z6VDNkdUxtTmhiR3dvZG1Gc2RXVXNJRndpWDE5aGQyRnBkRndpS1dBZ2RHOGdaR1YwWlhKdGFXNWxJR2xtSUhSb1pTQjVhV1ZzWkdWa0lIWmhiSFZsSUdselhHNGdJQzh2SUcxbFlXNTBJSFJ2SUdKbElHRjNZV2wwWldRdVhHNGdJR1Y0Y0c5eWRITXVZWGR5WVhBZ1BTQm1kVzVqZEdsdmJpaGhjbWNwSUh0Y2JpQWdJQ0J5WlhSMWNtNGdleUJmWDJGM1lXbDBPaUJoY21jZ2ZUdGNiaUFnZlR0Y2JseHVJQ0JtZFc1amRHbHZiaUJCYzNsdVkwbDBaWEpoZEc5eUtHZGxibVZ5WVhSdmNpa2dlMXh1SUNBZ0lHWjFibU4wYVc5dUlHbHVkbTlyWlNodFpYUm9iMlFzSUdGeVp5d2djbVZ6YjJ4MlpTd2djbVZxWldOMEtTQjdYRzRnSUNBZ0lDQjJZWElnY21WamIzSmtJRDBnZEhKNVEyRjBZMmdvWjJWdVpYSmhkRzl5VzIxbGRHaHZaRjBzSUdkbGJtVnlZWFJ2Y2l3Z1lYSm5LVHRjYmlBZ0lDQWdJR2xtSUNoeVpXTnZjbVF1ZEhsd1pTQTlQVDBnWENKMGFISnZkMXdpS1NCN1hHNGdJQ0FnSUNBZ0lISmxhbVZqZENoeVpXTnZjbVF1WVhKbktUdGNiaUFnSUNBZ0lIMGdaV3h6WlNCN1hHNGdJQ0FnSUNBZ0lIWmhjaUJ5WlhOMWJIUWdQU0J5WldOdmNtUXVZWEpuTzF4dUlDQWdJQ0FnSUNCMllYSWdkbUZzZFdVZ1BTQnlaWE4xYkhRdWRtRnNkV1U3WEc0Z0lDQWdJQ0FnSUdsbUlDaDJZV3gxWlNBbUpseHVJQ0FnSUNBZ0lDQWdJQ0FnZEhsd1pXOW1JSFpoYkhWbElEMDlQU0JjSW05aWFtVmpkRndpSUNZbVhHNGdJQ0FnSUNBZ0lDQWdJQ0JvWVhOUGQyNHVZMkZzYkNoMllXeDFaU3dnWENKZlgyRjNZV2wwWENJcEtTQjdYRzRnSUNBZ0lDQWdJQ0FnY21WMGRYSnVJRkJ5YjIxcGMyVXVjbVZ6YjJ4MlpTaDJZV3gxWlM1ZlgyRjNZV2wwS1M1MGFHVnVLR1oxYm1OMGFXOXVLSFpoYkhWbEtTQjdYRzRnSUNBZ0lDQWdJQ0FnSUNCcGJuWnZhMlVvWENKdVpYaDBYQ0lzSUhaaGJIVmxMQ0J5WlhOdmJIWmxMQ0J5WldwbFkzUXBPMXh1SUNBZ0lDQWdJQ0FnSUgwc0lHWjFibU4wYVc5dUtHVnljaWtnZTF4dUlDQWdJQ0FnSUNBZ0lDQWdhVzUyYjJ0bEtGd2lkR2h5YjNkY0lpd2daWEp5TENCeVpYTnZiSFpsTENCeVpXcGxZM1FwTzF4dUlDQWdJQ0FnSUNBZ0lIMHBPMXh1SUNBZ0lDQWdJQ0I5WEc1Y2JpQWdJQ0FnSUNBZ2NtVjBkWEp1SUZCeWIyMXBjMlV1Y21WemIyeDJaU2gyWVd4MVpTa3VkR2hsYmlobWRXNWpkR2x2YmloMWJuZHlZWEJ3WldRcElIdGNiaUFnSUNBZ0lDQWdJQ0F2THlCWGFHVnVJR0VnZVdsbGJHUmxaQ0JRY205dGFYTmxJR2x6SUhKbGMyOXNkbVZrTENCcGRITWdabWx1WVd3Z2RtRnNkV1VnWW1WamIyMWxjMXh1SUNBZ0lDQWdJQ0FnSUM4dklIUm9aU0F1ZG1Gc2RXVWdiMllnZEdobElGQnliMjFwYzJVOGUzWmhiSFZsTEdSdmJtVjlQaUJ5WlhOMWJIUWdabTl5SUhSb1pWeHVJQ0FnSUNBZ0lDQWdJQzh2SUdOMWNuSmxiblFnYVhSbGNtRjBhVzl1TGx4dUlDQWdJQ0FnSUNBZ0lISmxjM1ZzZEM1MllXeDFaU0E5SUhWdWQzSmhjSEJsWkR0Y2JpQWdJQ0FnSUNBZ0lDQnlaWE52YkhabEtISmxjM1ZzZENrN1hHNGdJQ0FnSUNBZ0lIMHNJR1oxYm1OMGFXOXVLR1Z5Y205eUtTQjdYRzRnSUNBZ0lDQWdJQ0FnTHk4Z1NXWWdZU0J5WldwbFkzUmxaQ0JRY205dGFYTmxJSGRoY3lCNWFXVnNaR1ZrTENCMGFISnZkeUIwYUdVZ2NtVnFaV04wYVc5dUlHSmhZMnRjYmlBZ0lDQWdJQ0FnSUNBdkx5QnBiblJ2SUhSb1pTQmhjM2x1WXlCblpXNWxjbUYwYjNJZ1puVnVZM1JwYjI0Z2MyOGdhWFFnWTJGdUlHSmxJR2hoYm1Sc1pXUWdkR2hsY21VdVhHNGdJQ0FnSUNBZ0lDQWdjbVYwZFhKdUlHbHVkbTlyWlNoY0luUm9jbTkzWENJc0lHVnljbTl5TENCeVpYTnZiSFpsTENCeVpXcGxZM1FwTzF4dUlDQWdJQ0FnSUNCOUtUdGNiaUFnSUNBZ0lIMWNiaUFnSUNCOVhHNWNiaUFnSUNCMllYSWdjSEpsZG1sdmRYTlFjbTl0YVhObE8xeHVYRzRnSUNBZ1puVnVZM1JwYjI0Z1pXNXhkV1YxWlNodFpYUm9iMlFzSUdGeVp5a2dlMXh1SUNBZ0lDQWdablZ1WTNScGIyNGdZMkZzYkVsdWRtOXJaVmRwZEdoTlpYUm9iMlJCYm1SQmNtY29LU0I3WEc0Z0lDQWdJQ0FnSUhKbGRIVnliaUJ1WlhjZ1VISnZiV2x6WlNobWRXNWpkR2x2YmloeVpYTnZiSFpsTENCeVpXcGxZM1FwSUh0Y2JpQWdJQ0FnSUNBZ0lDQnBiblp2YTJVb2JXVjBhRzlrTENCaGNtY3NJSEpsYzI5c2RtVXNJSEpsYW1WamRDazdYRzRnSUNBZ0lDQWdJSDBwTzF4dUlDQWdJQ0FnZlZ4dVhHNGdJQ0FnSUNCeVpYUjFjbTRnY0hKbGRtbHZkWE5RY205dGFYTmxJRDFjYmlBZ0lDQWdJQ0FnTHk4Z1NXWWdaVzV4ZFdWMVpTQm9ZWE1nWW1WbGJpQmpZV3hzWldRZ1ltVm1iM0psTENCMGFHVnVJSGRsSUhkaGJuUWdkRzhnZDJGcGRDQjFiblJwYkZ4dUlDQWdJQ0FnSUNBdkx5QmhiR3dnY0hKbGRtbHZkWE1nVUhKdmJXbHpaWE1nYUdGMlpTQmlaV1Z1SUhKbGMyOXNkbVZrSUdKbFptOXlaU0JqWVd4c2FXNW5JR2x1ZG05clpTeGNiaUFnSUNBZ0lDQWdMeThnYzI4Z2RHaGhkQ0J5WlhOMWJIUnpJR0Z5WlNCaGJIZGhlWE1nWkdWc2FYWmxjbVZrSUdsdUlIUm9aU0JqYjNKeVpXTjBJRzl5WkdWeUxpQkpabHh1SUNBZ0lDQWdJQ0F2THlCbGJuRjFaWFZsSUdoaGN5QnViM1FnWW1WbGJpQmpZV3hzWldRZ1ltVm1iM0psTENCMGFHVnVJR2wwSUdseklHbHRjRzl5ZEdGdWRDQjBiMXh1SUNBZ0lDQWdJQ0F2THlCallXeHNJR2x1ZG05clpTQnBiVzFsWkdsaGRHVnNlU3dnZDJsMGFHOTFkQ0IzWVdsMGFXNW5JRzl1SUdFZ1kyRnNiR0poWTJzZ2RHOGdabWx5WlN4Y2JpQWdJQ0FnSUNBZ0x5OGdjMjhnZEdoaGRDQjBhR1VnWVhONWJtTWdaMlZ1WlhKaGRHOXlJR1oxYm1OMGFXOXVJR2hoY3lCMGFHVWdiM0J3YjNKMGRXNXBkSGtnZEc4Z1pHOWNiaUFnSUNBZ0lDQWdMeThnWVc1NUlHNWxZMlZ6YzJGeWVTQnpaWFIxY0NCcGJpQmhJSEJ5WldScFkzUmhZbXhsSUhkaGVTNGdWR2hwY3lCd2NtVmthV04wWVdKcGJHbDBlVnh1SUNBZ0lDQWdJQ0F2THlCcGN5QjNhSGtnZEdobElGQnliMjFwYzJVZ1kyOXVjM1J5ZFdOMGIzSWdjM2x1WTJoeWIyNXZkWE5zZVNCcGJuWnZhMlZ6SUdsMGMxeHVJQ0FnSUNBZ0lDQXZMeUJsZUdWamRYUnZjaUJqWVd4c1ltRmpheXdnWVc1a0lIZG9lU0JoYzNsdVl5Qm1kVzVqZEdsdmJuTWdjM2x1WTJoeWIyNXZkWE5zZVZ4dUlDQWdJQ0FnSUNBdkx5QmxlR1ZqZFhSbElHTnZaR1VnWW1WbWIzSmxJSFJvWlNCbWFYSnpkQ0JoZDJGcGRDNGdVMmx1WTJVZ2QyVWdhVzF3YkdWdFpXNTBJSE5wYlhCc1pWeHVJQ0FnSUNBZ0lDQXZMeUJoYzNsdVl5Qm1kVzVqZEdsdmJuTWdhVzRnZEdWeWJYTWdiMllnWVhONWJtTWdaMlZ1WlhKaGRHOXljeXdnYVhRZ2FYTWdaWE53WldOcFlXeHNlVnh1SUNBZ0lDQWdJQ0F2THlCcGJYQnZjblJoYm5RZ2RHOGdaMlYwSUhSb2FYTWdjbWxuYUhRc0lHVjJaVzRnZEdodmRXZG9JR2wwSUhKbGNYVnBjbVZ6SUdOaGNtVXVYRzRnSUNBZ0lDQWdJSEJ5WlhacGIzVnpVSEp2YldselpTQS9JSEJ5WlhacGIzVnpVSEp2YldselpTNTBhR1Z1S0Z4dUlDQWdJQ0FnSUNBZ0lHTmhiR3hKYm5admEyVlhhWFJvVFdWMGFHOWtRVzVrUVhKbkxGeHVJQ0FnSUNBZ0lDQWdJQzh2SUVGMmIybGtJSEJ5YjNCaFoyRjBhVzVuSUdaaGFXeDFjbVZ6SUhSdklGQnliMjFwYzJWeklISmxkSFZ5Ym1Wa0lHSjVJR3hoZEdWeVhHNGdJQ0FnSUNBZ0lDQWdMeThnYVc1MmIyTmhkR2x2Ym5NZ2IyWWdkR2hsSUdsMFpYSmhkRzl5TGx4dUlDQWdJQ0FnSUNBZ0lHTmhiR3hKYm5admEyVlhhWFJvVFdWMGFHOWtRVzVrUVhKblhHNGdJQ0FnSUNBZ0lDa2dPaUJqWVd4c1NXNTJiMnRsVjJsMGFFMWxkR2h2WkVGdVpFRnlaeWdwTzF4dUlDQWdJSDFjYmx4dUlDQWdJQzh2SUVSbFptbHVaU0IwYUdVZ2RXNXBabWxsWkNCb1pXeHdaWElnYldWMGFHOWtJSFJvWVhRZ2FYTWdkWE5sWkNCMGJ5QnBiWEJzWlcxbGJuUWdMbTVsZUhRc1hHNGdJQ0FnTHk4Z0xuUm9jbTkzTENCaGJtUWdMbkpsZEhWeWJpQW9jMlZsSUdSbFptbHVaVWwwWlhKaGRHOXlUV1YwYUc5a2N5a3VYRzRnSUNBZ2RHaHBjeTVmYVc1MmIydGxJRDBnWlc1eGRXVjFaVHRjYmlBZ2ZWeHVYRzRnSUdSbFptbHVaVWwwWlhKaGRHOXlUV1YwYUc5a2N5aEJjM2x1WTBsMFpYSmhkRzl5TG5CeWIzUnZkSGx3WlNrN1hHNGdJRUZ6ZVc1alNYUmxjbUYwYjNJdWNISnZkRzkwZVhCbFcyRnplVzVqU1hSbGNtRjBiM0pUZVcxaWIyeGRJRDBnWm5WdVkzUnBiMjRnS0NrZ2UxeHVJQ0FnSUhKbGRIVnliaUIwYUdsek8xeHVJQ0I5TzF4dUlDQmxlSEJ2Y25SekxrRnplVzVqU1hSbGNtRjBiM0lnUFNCQmMzbHVZMGwwWlhKaGRHOXlPMXh1WEc0Z0lDOHZJRTV2ZEdVZ2RHaGhkQ0J6YVcxd2JHVWdZWE41Ym1NZ1puVnVZM1JwYjI1eklHRnlaU0JwYlhCc1pXMWxiblJsWkNCdmJpQjBiM0FnYjJaY2JpQWdMeThnUVhONWJtTkpkR1Z5WVhSdmNpQnZZbXBsWTNSek95QjBhR1Y1SUdwMWMzUWdjbVYwZFhKdUlHRWdVSEp2YldselpTQm1iM0lnZEdobElIWmhiSFZsSUc5bVhHNGdJQzh2SUhSb1pTQm1hVzVoYkNCeVpYTjFiSFFnY0hKdlpIVmpaV1FnWW5rZ2RHaGxJR2wwWlhKaGRHOXlMbHh1SUNCbGVIQnZjblJ6TG1GemVXNWpJRDBnWm5WdVkzUnBiMjRvYVc1dVpYSkdiaXdnYjNWMFpYSkdiaXdnYzJWc1ppd2dkSEo1VEc5amMweHBjM1FwSUh0Y2JpQWdJQ0IyWVhJZ2FYUmxjaUE5SUc1bGR5QkJjM2x1WTBsMFpYSmhkRzl5S0Z4dUlDQWdJQ0FnZDNKaGNDaHBibTVsY2tadUxDQnZkWFJsY2tadUxDQnpaV3htTENCMGNubE1iMk56VEdsemRDbGNiaUFnSUNBcE8xeHVYRzRnSUNBZ2NtVjBkWEp1SUdWNGNHOXlkSE11YVhOSFpXNWxjbUYwYjNKR2RXNWpkR2x2YmlodmRYUmxja1p1S1Z4dUlDQWdJQ0FnUHlCcGRHVnlJQzh2SUVsbUlHOTFkR1Z5Um00Z2FYTWdZU0JuWlc1bGNtRjBiM0lzSUhKbGRIVnliaUIwYUdVZ1puVnNiQ0JwZEdWeVlYUnZjaTVjYmlBZ0lDQWdJRG9nYVhSbGNpNXVaWGgwS0NrdWRHaGxiaWhtZFc1amRHbHZiaWh5WlhOMWJIUXBJSHRjYmlBZ0lDQWdJQ0FnSUNCeVpYUjFjbTRnY21WemRXeDBMbVJ2Ym1VZ1B5QnlaWE4xYkhRdWRtRnNkV1VnT2lCcGRHVnlMbTVsZUhRb0tUdGNiaUFnSUNBZ0lDQWdmU2s3WEc0Z0lIMDdYRzVjYmlBZ1puVnVZM1JwYjI0Z2JXRnJaVWx1ZG05clpVMWxkR2h2WkNocGJtNWxja1p1TENCelpXeG1MQ0JqYjI1MFpYaDBLU0I3WEc0Z0lDQWdkbUZ5SUhOMFlYUmxJRDBnUjJWdVUzUmhkR1ZUZFhOd1pXNWtaV1JUZEdGeWREdGNibHh1SUNBZ0lISmxkSFZ5YmlCbWRXNWpkR2x2YmlCcGJuWnZhMlVvYldWMGFHOWtMQ0JoY21jcElIdGNiaUFnSUNBZ0lHbG1JQ2h6ZEdGMFpTQTlQVDBnUjJWdVUzUmhkR1ZGZUdWamRYUnBibWNwSUh0Y2JpQWdJQ0FnSUNBZ2RHaHliM2NnYm1WM0lFVnljbTl5S0Z3aVIyVnVaWEpoZEc5eUlHbHpJR0ZzY21WaFpIa2djblZ1Ym1sdVoxd2lLVHRjYmlBZ0lDQWdJSDFjYmx4dUlDQWdJQ0FnYVdZZ0tITjBZWFJsSUQwOVBTQkhaVzVUZEdGMFpVTnZiWEJzWlhSbFpDa2dlMXh1SUNBZ0lDQWdJQ0JwWmlBb2JXVjBhRzlrSUQwOVBTQmNJblJvY205M1hDSXBJSHRjYmlBZ0lDQWdJQ0FnSUNCMGFISnZkeUJoY21jN1hHNGdJQ0FnSUNBZ0lIMWNibHh1SUNBZ0lDQWdJQ0F2THlCQ1pTQm1iM0puYVhacGJtY3NJSEJsY2lBeU5TNHpMak11TXk0eklHOW1JSFJvWlNCemNHVmpPbHh1SUNBZ0lDQWdJQ0F2THlCb2RIUndjem92TDNCbGIzQnNaUzV0YjNwcGJHeGhMbTl5Wnk5K2FtOXlaVzVrYjNKbVppOWxjell0WkhKaFpuUXVhSFJ0YkNOelpXTXRaMlZ1WlhKaGRHOXljbVZ6ZFcxbFhHNGdJQ0FnSUNBZ0lISmxkSFZ5YmlCa2IyNWxVbVZ6ZFd4MEtDazdYRzRnSUNBZ0lDQjlYRzVjYmlBZ0lDQWdJR052Ym5SbGVIUXViV1YwYUc5a0lEMGdiV1YwYUc5a08xeHVJQ0FnSUNBZ1kyOXVkR1Y0ZEM1aGNtY2dQU0JoY21jN1hHNWNiaUFnSUNBZ0lIZG9hV3hsSUNoMGNuVmxLU0I3WEc0Z0lDQWdJQ0FnSUhaaGNpQmtaV3hsWjJGMFpTQTlJR052Ym5SbGVIUXVaR1ZzWldkaGRHVTdYRzRnSUNBZ0lDQWdJR2xtSUNoa1pXeGxaMkYwWlNrZ2UxeHVJQ0FnSUNBZ0lDQWdJSFpoY2lCa1pXeGxaMkYwWlZKbGMzVnNkQ0E5SUcxaGVXSmxTVzUyYjJ0bFJHVnNaV2RoZEdVb1pHVnNaV2RoZEdVc0lHTnZiblJsZUhRcE8xeHVJQ0FnSUNBZ0lDQWdJR2xtSUNoa1pXeGxaMkYwWlZKbGMzVnNkQ2tnZTF4dUlDQWdJQ0FnSUNBZ0lDQWdhV1lnS0dSbGJHVm5ZWFJsVW1WemRXeDBJRDA5UFNCRGIyNTBhVzUxWlZObGJuUnBibVZzS1NCamIyNTBhVzUxWlR0Y2JpQWdJQ0FnSUNBZ0lDQWdJSEpsZEhWeWJpQmtaV3hsWjJGMFpWSmxjM1ZzZER0Y2JpQWdJQ0FnSUNBZ0lDQjlYRzRnSUNBZ0lDQWdJSDFjYmx4dUlDQWdJQ0FnSUNCcFppQW9ZMjl1ZEdWNGRDNXRaWFJvYjJRZ1BUMDlJRndpYm1WNGRGd2lLU0I3WEc0Z0lDQWdJQ0FnSUNBZ0x5OGdVMlYwZEdsdVp5QmpiMjUwWlhoMExsOXpaVzUwSUdadmNpQnNaV2RoWTNrZ2MzVndjRzl5ZENCdlppQkNZV0psYkNkelhHNGdJQ0FnSUNBZ0lDQWdMeThnWm5WdVkzUnBiMjR1YzJWdWRDQnBiWEJzWlcxbGJuUmhkR2x2Ymk1Y2JpQWdJQ0FnSUNBZ0lDQmpiMjUwWlhoMExuTmxiblFnUFNCamIyNTBaWGgwTGw5elpXNTBJRDBnWTI5dWRHVjRkQzVoY21jN1hHNWNiaUFnSUNBZ0lDQWdmU0JsYkhObElHbG1JQ2hqYjI1MFpYaDBMbTFsZEdodlpDQTlQVDBnWENKMGFISnZkMXdpS1NCN1hHNGdJQ0FnSUNBZ0lDQWdhV1lnS0hOMFlYUmxJRDA5UFNCSFpXNVRkR0YwWlZOMWMzQmxibVJsWkZOMFlYSjBLU0I3WEc0Z0lDQWdJQ0FnSUNBZ0lDQnpkR0YwWlNBOUlFZGxibE4wWVhSbFEyOXRjR3hsZEdWa08xeHVJQ0FnSUNBZ0lDQWdJQ0FnZEdoeWIzY2dZMjl1ZEdWNGRDNWhjbWM3WEc0Z0lDQWdJQ0FnSUNBZ2ZWeHVYRzRnSUNBZ0lDQWdJQ0FnWTI5dWRHVjRkQzVrYVhOd1lYUmphRVY0WTJWd2RHbHZiaWhqYjI1MFpYaDBMbUZ5WnlrN1hHNWNiaUFnSUNBZ0lDQWdmU0JsYkhObElHbG1JQ2hqYjI1MFpYaDBMbTFsZEdodlpDQTlQVDBnWENKeVpYUjFjbTVjSWlrZ2UxeHVJQ0FnSUNBZ0lDQWdJR052Ym5SbGVIUXVZV0p5ZFhCMEtGd2ljbVYwZFhKdVhDSXNJR052Ym5SbGVIUXVZWEpuS1R0Y2JpQWdJQ0FnSUNBZ2ZWeHVYRzRnSUNBZ0lDQWdJSE4wWVhSbElEMGdSMlZ1VTNSaGRHVkZlR1ZqZFhScGJtYzdYRzVjYmlBZ0lDQWdJQ0FnZG1GeUlISmxZMjl5WkNBOUlIUnllVU5oZEdOb0tHbHVibVZ5Um00c0lITmxiR1lzSUdOdmJuUmxlSFFwTzF4dUlDQWdJQ0FnSUNCcFppQW9jbVZqYjNKa0xuUjVjR1VnUFQwOUlGd2libTl5YldGc1hDSXBJSHRjYmlBZ0lDQWdJQ0FnSUNBdkx5QkpaaUJoYmlCbGVHTmxjSFJwYjI0Z2FYTWdkR2h5YjNkdUlHWnliMjBnYVc1dVpYSkdiaXdnZDJVZ2JHVmhkbVVnYzNSaGRHVWdQVDA5WEc0Z0lDQWdJQ0FnSUNBZ0x5OGdSMlZ1VTNSaGRHVkZlR1ZqZFhScGJtY2dZVzVrSUd4dmIzQWdZbUZqYXlCbWIzSWdZVzV2ZEdobGNpQnBiblp2WTJGMGFXOXVMbHh1SUNBZ0lDQWdJQ0FnSUhOMFlYUmxJRDBnWTI5dWRHVjRkQzVrYjI1bFhHNGdJQ0FnSUNBZ0lDQWdJQ0EvSUVkbGJsTjBZWFJsUTI5dGNHeGxkR1ZrWEc0Z0lDQWdJQ0FnSUNBZ0lDQTZJRWRsYmxOMFlYUmxVM1Z6Y0dWdVpHVmtXV2xsYkdRN1hHNWNiaUFnSUNBZ0lDQWdJQ0JwWmlBb2NtVmpiM0prTG1GeVp5QTlQVDBnUTI5dWRHbHVkV1ZUWlc1MGFXNWxiQ2tnZTF4dUlDQWdJQ0FnSUNBZ0lDQWdZMjl1ZEdsdWRXVTdYRzRnSUNBZ0lDQWdJQ0FnZlZ4dVhHNGdJQ0FnSUNBZ0lDQWdjbVYwZFhKdUlIdGNiaUFnSUNBZ0lDQWdJQ0FnSUhaaGJIVmxPaUJ5WldOdmNtUXVZWEpuTEZ4dUlDQWdJQ0FnSUNBZ0lDQWdaRzl1WlRvZ1kyOXVkR1Y0ZEM1a2IyNWxYRzRnSUNBZ0lDQWdJQ0FnZlR0Y2JseHVJQ0FnSUNBZ0lDQjlJR1ZzYzJVZ2FXWWdLSEpsWTI5eVpDNTBlWEJsSUQwOVBTQmNJblJvY205M1hDSXBJSHRjYmlBZ0lDQWdJQ0FnSUNCemRHRjBaU0E5SUVkbGJsTjBZWFJsUTI5dGNHeGxkR1ZrTzF4dUlDQWdJQ0FnSUNBZ0lDOHZJRVJwYzNCaGRHTm9JSFJvWlNCbGVHTmxjSFJwYjI0Z1lua2diRzl2Y0dsdVp5QmlZV05ySUdGeWIzVnVaQ0IwYnlCMGFHVmNiaUFnSUNBZ0lDQWdJQ0F2THlCamIyNTBaWGgwTG1ScGMzQmhkR05vUlhoalpYQjBhVzl1S0dOdmJuUmxlSFF1WVhKbktTQmpZV3hzSUdGaWIzWmxMbHh1SUNBZ0lDQWdJQ0FnSUdOdmJuUmxlSFF1YldWMGFHOWtJRDBnWENKMGFISnZkMXdpTzF4dUlDQWdJQ0FnSUNBZ0lHTnZiblJsZUhRdVlYSm5JRDBnY21WamIzSmtMbUZ5Wnp0Y2JpQWdJQ0FnSUNBZ2ZWeHVJQ0FnSUNBZ2ZWeHVJQ0FnSUgwN1hHNGdJSDFjYmx4dUlDQXZMeUJEWVd4c0lHUmxiR1ZuWVhSbExtbDBaWEpoZEc5eVcyTnZiblJsZUhRdWJXVjBhRzlrWFNoamIyNTBaWGgwTG1GeVp5a2dZVzVrSUdoaGJtUnNaU0IwYUdWY2JpQWdMeThnY21WemRXeDBMQ0JsYVhSb1pYSWdZbmtnY21WMGRYSnVhVzVuSUdFZ2V5QjJZV3gxWlN3Z1pHOXVaU0I5SUhKbGMzVnNkQ0JtY205dElIUm9aVnh1SUNBdkx5QmtaV3hsWjJGMFpTQnBkR1Z5WVhSdmNpd2diM0lnWW5rZ2JXOWthV1o1YVc1bklHTnZiblJsZUhRdWJXVjBhRzlrSUdGdVpDQmpiMjUwWlhoMExtRnlaeXhjYmlBZ0x5OGdjMlYwZEdsdVp5QmpiMjUwWlhoMExtUmxiR1ZuWVhSbElIUnZJRzUxYkd3c0lHRnVaQ0J5WlhSMWNtNXBibWNnZEdobElFTnZiblJwYm5WbFUyVnVkR2x1Wld3dVhHNGdJR1oxYm1OMGFXOXVJRzFoZVdKbFNXNTJiMnRsUkdWc1pXZGhkR1VvWkdWc1pXZGhkR1VzSUdOdmJuUmxlSFFwSUh0Y2JpQWdJQ0IyWVhJZ2JXVjBhRzlrSUQwZ1pHVnNaV2RoZEdVdWFYUmxjbUYwYjNKYlkyOXVkR1Y0ZEM1dFpYUm9iMlJkTzF4dUlDQWdJR2xtSUNodFpYUm9iMlFnUFQwOUlIVnVaR1ZtYVc1bFpDa2dlMXh1SUNBZ0lDQWdMeThnUVNBdWRHaHliM2NnYjNJZ0xuSmxkSFZ5YmlCM2FHVnVJSFJvWlNCa1pXeGxaMkYwWlNCcGRHVnlZWFJ2Y2lCb1lYTWdibThnTG5Sb2NtOTNYRzRnSUNBZ0lDQXZMeUJ0WlhSb2IyUWdZV3gzWVhseklIUmxjbTFwYm1GMFpYTWdkR2hsSUhscFpXeGtLaUJzYjI5d0xseHVJQ0FnSUNBZ1kyOXVkR1Y0ZEM1a1pXeGxaMkYwWlNBOUlHNTFiR3c3WEc1Y2JpQWdJQ0FnSUdsbUlDaGpiMjUwWlhoMExtMWxkR2h2WkNBOVBUMGdYQ0owYUhKdmQxd2lLU0I3WEc0Z0lDQWdJQ0FnSUM4dklFNXZkR1U2SUZ0Y0luSmxkSFZ5Ymx3aVhTQnRkWE4wSUdKbElIVnpaV1FnWm05eUlFVlRNeUJ3WVhKemFXNW5JR052YlhCaGRHbGlhV3hwZEhrdVhHNGdJQ0FnSUNBZ0lHbG1JQ2hrWld4bFoyRjBaUzVwZEdWeVlYUnZjbHRjSW5KbGRIVnlibHdpWFNrZ2UxeHVJQ0FnSUNBZ0lDQWdJQzh2SUVsbUlIUm9aU0JrWld4bFoyRjBaU0JwZEdWeVlYUnZjaUJvWVhNZ1lTQnlaWFIxY200Z2JXVjBhRzlrTENCbmFYWmxJR2wwSUdGY2JpQWdJQ0FnSUNBZ0lDQXZMeUJqYUdGdVkyVWdkRzhnWTJ4bFlXNGdkWEF1WEc0Z0lDQWdJQ0FnSUNBZ1kyOXVkR1Y0ZEM1dFpYUm9iMlFnUFNCY0luSmxkSFZ5Ymx3aU8xeHVJQ0FnSUNBZ0lDQWdJR052Ym5SbGVIUXVZWEpuSUQwZ2RXNWtaV1pwYm1Wa08xeHVJQ0FnSUNBZ0lDQWdJRzFoZVdKbFNXNTJiMnRsUkdWc1pXZGhkR1VvWkdWc1pXZGhkR1VzSUdOdmJuUmxlSFFwTzF4dVhHNGdJQ0FnSUNBZ0lDQWdhV1lnS0dOdmJuUmxlSFF1YldWMGFHOWtJRDA5UFNCY0luUm9jbTkzWENJcElIdGNiaUFnSUNBZ0lDQWdJQ0FnSUM4dklFbG1JRzFoZVdKbFNXNTJiMnRsUkdWc1pXZGhkR1VvWTI5dWRHVjRkQ2tnWTJoaGJtZGxaQ0JqYjI1MFpYaDBMbTFsZEdodlpDQm1jbTl0WEc0Z0lDQWdJQ0FnSUNBZ0lDQXZMeUJjSW5KbGRIVnlibHdpSUhSdklGd2lkR2h5YjNkY0lpd2diR1YwSUhSb1lYUWdiM1psY25KcFpHVWdkR2hsSUZSNWNHVkZjbkp2Y2lCaVpXeHZkeTVjYmlBZ0lDQWdJQ0FnSUNBZ0lISmxkSFZ5YmlCRGIyNTBhVzUxWlZObGJuUnBibVZzTzF4dUlDQWdJQ0FnSUNBZ0lIMWNiaUFnSUNBZ0lDQWdmVnh1WEc0Z0lDQWdJQ0FnSUdOdmJuUmxlSFF1YldWMGFHOWtJRDBnWENKMGFISnZkMXdpTzF4dUlDQWdJQ0FnSUNCamIyNTBaWGgwTG1GeVp5QTlJRzVsZHlCVWVYQmxSWEp5YjNJb1hHNGdJQ0FnSUNBZ0lDQWdYQ0pVYUdVZ2FYUmxjbUYwYjNJZ1pHOWxjeUJ1YjNRZ2NISnZkbWxrWlNCaElDZDBhSEp2ZHljZ2JXVjBhRzlrWENJcE8xeHVJQ0FnSUNBZ2ZWeHVYRzRnSUNBZ0lDQnlaWFIxY200Z1EyOXVkR2x1ZFdWVFpXNTBhVzVsYkR0Y2JpQWdJQ0I5WEc1Y2JpQWdJQ0IyWVhJZ2NtVmpiM0prSUQwZ2RISjVRMkYwWTJnb2JXVjBhRzlrTENCa1pXeGxaMkYwWlM1cGRHVnlZWFJ2Y2l3Z1kyOXVkR1Y0ZEM1aGNtY3BPMXh1WEc0Z0lDQWdhV1lnS0hKbFkyOXlaQzUwZVhCbElEMDlQU0JjSW5Sb2NtOTNYQ0lwSUh0Y2JpQWdJQ0FnSUdOdmJuUmxlSFF1YldWMGFHOWtJRDBnWENKMGFISnZkMXdpTzF4dUlDQWdJQ0FnWTI5dWRHVjRkQzVoY21jZ1BTQnlaV052Y21RdVlYSm5PMXh1SUNBZ0lDQWdZMjl1ZEdWNGRDNWtaV3hsWjJGMFpTQTlJRzUxYkd3N1hHNGdJQ0FnSUNCeVpYUjFjbTRnUTI5dWRHbHVkV1ZUWlc1MGFXNWxiRHRjYmlBZ0lDQjlYRzVjYmlBZ0lDQjJZWElnYVc1bWJ5QTlJSEpsWTI5eVpDNWhjbWM3WEc1Y2JpQWdJQ0JwWmlBb0lTQnBibVp2S1NCN1hHNGdJQ0FnSUNCamIyNTBaWGgwTG0xbGRHaHZaQ0E5SUZ3aWRHaHliM2RjSWp0Y2JpQWdJQ0FnSUdOdmJuUmxlSFF1WVhKbklEMGdibVYzSUZSNWNHVkZjbkp2Y2loY0ltbDBaWEpoZEc5eUlISmxjM1ZzZENCcGN5QnViM1FnWVc0Z2IySnFaV04wWENJcE8xeHVJQ0FnSUNBZ1kyOXVkR1Y0ZEM1a1pXeGxaMkYwWlNBOUlHNTFiR3c3WEc0Z0lDQWdJQ0J5WlhSMWNtNGdRMjl1ZEdsdWRXVlRaVzUwYVc1bGJEdGNiaUFnSUNCOVhHNWNiaUFnSUNCcFppQW9hVzVtYnk1a2IyNWxLU0I3WEc0Z0lDQWdJQ0F2THlCQmMzTnBaMjRnZEdobElISmxjM1ZzZENCdlppQjBhR1VnWm1sdWFYTm9aV1FnWkdWc1pXZGhkR1VnZEc4Z2RHaGxJSFJsYlhCdmNtRnllVnh1SUNBZ0lDQWdMeThnZG1GeWFXRmliR1VnYzNCbFkybG1hV1ZrSUdKNUlHUmxiR1ZuWVhSbExuSmxjM1ZzZEU1aGJXVWdLSE5sWlNCa1pXeGxaMkYwWlZscFpXeGtLUzVjYmlBZ0lDQWdJR052Ym5SbGVIUmJaR1ZzWldkaGRHVXVjbVZ6ZFd4MFRtRnRaVjBnUFNCcGJtWnZMblpoYkhWbE8xeHVYRzRnSUNBZ0lDQXZMeUJTWlhOMWJXVWdaWGhsWTNWMGFXOXVJR0YwSUhSb1pTQmtaWE5wY21Wa0lHeHZZMkYwYVc5dUlDaHpaV1VnWkdWc1pXZGhkR1ZaYVdWc1pDa3VYRzRnSUNBZ0lDQmpiMjUwWlhoMExtNWxlSFFnUFNCa1pXeGxaMkYwWlM1dVpYaDBURzlqTzF4dVhHNGdJQ0FnSUNBdkx5QkpaaUJqYjI1MFpYaDBMbTFsZEdodlpDQjNZWE1nWENKMGFISnZkMXdpSUdKMWRDQjBhR1VnWkdWc1pXZGhkR1VnYUdGdVpHeGxaQ0IwYUdWY2JpQWdJQ0FnSUM4dklHVjRZMlZ3ZEdsdmJpd2diR1YwSUhSb1pTQnZkWFJsY2lCblpXNWxjbUYwYjNJZ2NISnZZMlZsWkNCdWIzSnRZV3hzZVM0Z1NXWmNiaUFnSUNBZ0lDOHZJR052Ym5SbGVIUXViV1YwYUc5a0lIZGhjeUJjSW01bGVIUmNJaXdnWm05eVoyVjBJR052Ym5SbGVIUXVZWEpuSUhOcGJtTmxJR2wwSUdoaGN5QmlaV1Z1WEc0Z0lDQWdJQ0F2THlCY0ltTnZibk4xYldWa1hDSWdZbmtnZEdobElHUmxiR1ZuWVhSbElHbDBaWEpoZEc5eUxpQkpaaUJqYjI1MFpYaDBMbTFsZEdodlpDQjNZWE5jYmlBZ0lDQWdJQzh2SUZ3aWNtVjBkWEp1WENJc0lHRnNiRzkzSUhSb1pTQnZjbWxuYVc1aGJDQXVjbVYwZFhKdUlHTmhiR3dnZEc4Z1kyOXVkR2x1ZFdVZ2FXNGdkR2hsWEc0Z0lDQWdJQ0F2THlCdmRYUmxjaUJuWlc1bGNtRjBiM0l1WEc0Z0lDQWdJQ0JwWmlBb1kyOXVkR1Y0ZEM1dFpYUm9iMlFnSVQwOUlGd2ljbVYwZFhKdVhDSXBJSHRjYmlBZ0lDQWdJQ0FnWTI5dWRHVjRkQzV0WlhSb2IyUWdQU0JjSW01bGVIUmNJanRjYmlBZ0lDQWdJQ0FnWTI5dWRHVjRkQzVoY21jZ1BTQjFibVJsWm1sdVpXUTdYRzRnSUNBZ0lDQjlYRzVjYmlBZ0lDQjlJR1ZzYzJVZ2UxeHVJQ0FnSUNBZ0x5OGdVbVV0ZVdsbGJHUWdkR2hsSUhKbGMzVnNkQ0J5WlhSMWNtNWxaQ0JpZVNCMGFHVWdaR1ZzWldkaGRHVWdiV1YwYUc5a0xseHVJQ0FnSUNBZ2NtVjBkWEp1SUdsdVptODdYRzRnSUNBZ2ZWeHVYRzRnSUNBZ0x5OGdWR2hsSUdSbGJHVm5ZWFJsSUdsMFpYSmhkRzl5SUdseklHWnBibWx6YUdWa0xDQnpieUJtYjNKblpYUWdhWFFnWVc1a0lHTnZiblJwYm5WbElIZHBkR2hjYmlBZ0lDQXZMeUIwYUdVZ2IzVjBaWElnWjJWdVpYSmhkRzl5TGx4dUlDQWdJR052Ym5SbGVIUXVaR1ZzWldkaGRHVWdQU0J1ZFd4c08xeHVJQ0FnSUhKbGRIVnliaUJEYjI1MGFXNTFaVk5sYm5ScGJtVnNPMXh1SUNCOVhHNWNiaUFnTHk4Z1JHVm1hVzVsSUVkbGJtVnlZWFJ2Y2k1d2NtOTBiM1I1Y0dVdWUyNWxlSFFzZEdoeWIzY3NjbVYwZFhKdWZTQnBiaUIwWlhKdGN5QnZaaUIwYUdWY2JpQWdMeThnZFc1cFptbGxaQ0F1WDJsdWRtOXJaU0JvWld4d1pYSWdiV1YwYUc5a0xseHVJQ0JrWldacGJtVkpkR1Z5WVhSdmNrMWxkR2h2WkhNb1IzQXBPMXh1WEc0Z0lFZHdXM1J2VTNSeWFXNW5WR0ZuVTNsdFltOXNYU0E5SUZ3aVIyVnVaWEpoZEc5eVhDSTdYRzVjYmlBZ0x5OGdRU0JIWlc1bGNtRjBiM0lnYzJodmRXeGtJR0ZzZDJGNWN5QnlaWFIxY200Z2FYUnpaV3htSUdGeklIUm9aU0JwZEdWeVlYUnZjaUJ2WW1wbFkzUWdkMmhsYmlCMGFHVmNiaUFnTHk4Z1FFQnBkR1Z5WVhSdmNpQm1kVzVqZEdsdmJpQnBjeUJqWVd4c1pXUWdiMjRnYVhRdUlGTnZiV1VnWW5KdmQzTmxjbk1uSUdsdGNHeGxiV1Z1ZEdGMGFXOXVjeUJ2WmlCMGFHVmNiaUFnTHk4Z2FYUmxjbUYwYjNJZ2NISnZkRzkwZVhCbElHTm9ZV2x1SUdsdVkyOXljbVZqZEd4NUlHbHRjR3hsYldWdWRDQjBhR2x6TENCallYVnphVzVuSUhSb1pTQkhaVzVsY21GMGIzSmNiaUFnTHk4Z2IySnFaV04wSUhSdklHNXZkQ0JpWlNCeVpYUjFjbTVsWkNCbWNtOXRJSFJvYVhNZ1kyRnNiQzRnVkdocGN5Qmxibk4xY21WeklIUm9ZWFFnWkc5bGMyNG5kQ0JvWVhCd1pXNHVYRzRnSUM4dklGTmxaU0JvZEhSd2N6b3ZMMmRwZEdoMVlpNWpiMjB2Wm1GalpXSnZiMnN2Y21WblpXNWxjbUYwYjNJdmFYTnpkV1Z6THpJM05DQm1iM0lnYlc5eVpTQmtaWFJoYVd4ekxseHVJQ0JIY0Z0cGRHVnlZWFJ2Y2xONWJXSnZiRjBnUFNCbWRXNWpkR2x2YmlncElIdGNiaUFnSUNCeVpYUjFjbTRnZEdocGN6dGNiaUFnZlR0Y2JseHVJQ0JIY0M1MGIxTjBjbWx1WnlBOUlHWjFibU4wYVc5dUtDa2dlMXh1SUNBZ0lISmxkSFZ5YmlCY0lsdHZZbXBsWTNRZ1IyVnVaWEpoZEc5eVhWd2lPMXh1SUNCOU8xeHVYRzRnSUdaMWJtTjBhVzl1SUhCMWMyaFVjbmxGYm5SeWVTaHNiMk56S1NCN1hHNGdJQ0FnZG1GeUlHVnVkSEo1SUQwZ2V5QjBjbmxNYjJNNklHeHZZM05iTUYwZ2ZUdGNibHh1SUNBZ0lHbG1JQ2d4SUdsdUlHeHZZM01wSUh0Y2JpQWdJQ0FnSUdWdWRISjVMbU5oZEdOb1RHOWpJRDBnYkc5amMxc3hYVHRjYmlBZ0lDQjlYRzVjYmlBZ0lDQnBaaUFvTWlCcGJpQnNiMk56S1NCN1hHNGdJQ0FnSUNCbGJuUnllUzVtYVc1aGJHeDVURzlqSUQwZ2JHOWpjMXN5WFR0Y2JpQWdJQ0FnSUdWdWRISjVMbUZtZEdWeVRHOWpJRDBnYkc5amMxc3pYVHRjYmlBZ0lDQjlYRzVjYmlBZ0lDQjBhR2x6TG5SeWVVVnVkSEpwWlhNdWNIVnphQ2hsYm5SeWVTazdYRzRnSUgxY2JseHVJQ0JtZFc1amRHbHZiaUJ5WlhObGRGUnllVVZ1ZEhKNUtHVnVkSEo1S1NCN1hHNGdJQ0FnZG1GeUlISmxZMjl5WkNBOUlHVnVkSEo1TG1OdmJYQnNaWFJwYjI0Z2ZId2dlMzA3WEc0Z0lDQWdjbVZqYjNKa0xuUjVjR1VnUFNCY0ltNXZjbTFoYkZ3aU8xeHVJQ0FnSUdSbGJHVjBaU0J5WldOdmNtUXVZWEpuTzF4dUlDQWdJR1Z1ZEhKNUxtTnZiWEJzWlhScGIyNGdQU0J5WldOdmNtUTdYRzRnSUgxY2JseHVJQ0JtZFc1amRHbHZiaUJEYjI1MFpYaDBLSFJ5ZVV4dlkzTk1hWE4wS1NCN1hHNGdJQ0FnTHk4Z1ZHaGxJSEp2YjNRZ1pXNTBjbmtnYjJKcVpXTjBJQ2hsWm1abFkzUnBkbVZzZVNCaElIUnllU0J6ZEdGMFpXMWxiblFnZDJsMGFHOTFkQ0JoSUdOaGRHTm9YRzRnSUNBZ0x5OGdiM0lnWVNCbWFXNWhiR3g1SUdKc2IyTnJLU0JuYVhabGN5QjFjeUJoSUhCc1lXTmxJSFJ2SUhOMGIzSmxJSFpoYkhWbGN5QjBhSEp2ZDI0Z1puSnZiVnh1SUNBZ0lDOHZJR3h2WTJGMGFXOXVjeUIzYUdWeVpTQjBhR1Z5WlNCcGN5QnVieUJsYm1Oc2IzTnBibWNnZEhKNUlITjBZWFJsYldWdWRDNWNiaUFnSUNCMGFHbHpMblJ5ZVVWdWRISnBaWE1nUFNCYmV5QjBjbmxNYjJNNklGd2ljbTl2ZEZ3aUlIMWRPMXh1SUNBZ0lIUnllVXh2WTNOTWFYTjBMbVp2Y2tWaFkyZ29jSFZ6YUZSeWVVVnVkSEo1TENCMGFHbHpLVHRjYmlBZ0lDQjBhR2x6TG5KbGMyVjBLSFJ5ZFdVcE8xeHVJQ0I5WEc1Y2JpQWdaWGh3YjNKMGN5NXJaWGx6SUQwZ1puVnVZM1JwYjI0b2IySnFaV04wS1NCN1hHNGdJQ0FnZG1GeUlHdGxlWE1nUFNCYlhUdGNiaUFnSUNCbWIzSWdLSFpoY2lCclpYa2dhVzRnYjJKcVpXTjBLU0I3WEc0Z0lDQWdJQ0JyWlhsekxuQjFjMmdvYTJWNUtUdGNiaUFnSUNCOVhHNGdJQ0FnYTJWNWN5NXlaWFpsY25ObEtDazdYRzVjYmlBZ0lDQXZMeUJTWVhSb1pYSWdkR2hoYmlCeVpYUjFjbTVwYm1jZ1lXNGdiMkpxWldOMElIZHBkR2dnWVNCdVpYaDBJRzFsZEdodlpDd2dkMlVnYTJWbGNGeHVJQ0FnSUM4dklIUm9hVzVuY3lCemFXMXdiR1VnWVc1a0lISmxkSFZ5YmlCMGFHVWdibVY0ZENCbWRXNWpkR2x2YmlCcGRITmxiR1l1WEc0Z0lDQWdjbVYwZFhKdUlHWjFibU4wYVc5dUlHNWxlSFFvS1NCN1hHNGdJQ0FnSUNCM2FHbHNaU0FvYTJWNWN5NXNaVzVuZEdncElIdGNiaUFnSUNBZ0lDQWdkbUZ5SUd0bGVTQTlJR3RsZVhNdWNHOXdLQ2s3WEc0Z0lDQWdJQ0FnSUdsbUlDaHJaWGtnYVc0Z2IySnFaV04wS1NCN1hHNGdJQ0FnSUNBZ0lDQWdibVY0ZEM1MllXeDFaU0E5SUd0bGVUdGNiaUFnSUNBZ0lDQWdJQ0J1WlhoMExtUnZibVVnUFNCbVlXeHpaVHRjYmlBZ0lDQWdJQ0FnSUNCeVpYUjFjbTRnYm1WNGREdGNiaUFnSUNBZ0lDQWdmVnh1SUNBZ0lDQWdmVnh1WEc0Z0lDQWdJQ0F2THlCVWJ5QmhkbTlwWkNCamNtVmhkR2x1WnlCaGJpQmhaR1JwZEdsdmJtRnNJRzlpYW1WamRDd2dkMlVnYW5WemRDQm9ZVzVuSUhSb1pTQXVkbUZzZFdWY2JpQWdJQ0FnSUM4dklHRnVaQ0F1Wkc5dVpTQndjbTl3WlhKMGFXVnpJRzltWmlCMGFHVWdibVY0ZENCbWRXNWpkR2x2YmlCdlltcGxZM1FnYVhSelpXeG1MaUJVYUdselhHNGdJQ0FnSUNBdkx5QmhiSE52SUdWdWMzVnlaWE1nZEdoaGRDQjBhR1VnYldsdWFXWnBaWElnZDJsc2JDQnViM1FnWVc1dmJubHRhWHBsSUhSb1pTQm1kVzVqZEdsdmJpNWNiaUFnSUNBZ0lHNWxlSFF1Wkc5dVpTQTlJSFJ5ZFdVN1hHNGdJQ0FnSUNCeVpYUjFjbTRnYm1WNGREdGNiaUFnSUNCOU8xeHVJQ0I5TzF4dVhHNGdJR1oxYm1OMGFXOXVJSFpoYkhWbGN5aHBkR1Z5WVdKc1pTa2dlMXh1SUNBZ0lHbG1JQ2hwZEdWeVlXSnNaU2tnZTF4dUlDQWdJQ0FnZG1GeUlHbDBaWEpoZEc5eVRXVjBhRzlrSUQwZ2FYUmxjbUZpYkdWYmFYUmxjbUYwYjNKVGVXMWliMnhkTzF4dUlDQWdJQ0FnYVdZZ0tHbDBaWEpoZEc5eVRXVjBhRzlrS1NCN1hHNGdJQ0FnSUNBZ0lISmxkSFZ5YmlCcGRHVnlZWFJ2Y2sxbGRHaHZaQzVqWVd4c0tHbDBaWEpoWW14bEtUdGNiaUFnSUNBZ0lIMWNibHh1SUNBZ0lDQWdhV1lnS0hSNWNHVnZaaUJwZEdWeVlXSnNaUzV1WlhoMElEMDlQU0JjSW1aMWJtTjBhVzl1WENJcElIdGNiaUFnSUNBZ0lDQWdjbVYwZFhKdUlHbDBaWEpoWW14bE8xeHVJQ0FnSUNBZ2ZWeHVYRzRnSUNBZ0lDQnBaaUFvSVdselRtRk9LR2wwWlhKaFlteGxMbXhsYm1kMGFDa3BJSHRjYmlBZ0lDQWdJQ0FnZG1GeUlHa2dQU0F0TVN3Z2JtVjRkQ0E5SUdaMWJtTjBhVzl1SUc1bGVIUW9LU0I3WEc0Z0lDQWdJQ0FnSUNBZ2QyaHBiR1VnS0NzcmFTQThJR2wwWlhKaFlteGxMbXhsYm1kMGFDa2dlMXh1SUNBZ0lDQWdJQ0FnSUNBZ2FXWWdLR2hoYzA5M2JpNWpZV3hzS0dsMFpYSmhZbXhsTENCcEtTa2dlMXh1SUNBZ0lDQWdJQ0FnSUNBZ0lDQnVaWGgwTG5aaGJIVmxJRDBnYVhSbGNtRmliR1ZiYVYwN1hHNGdJQ0FnSUNBZ0lDQWdJQ0FnSUc1bGVIUXVaRzl1WlNBOUlHWmhiSE5sTzF4dUlDQWdJQ0FnSUNBZ0lDQWdJQ0J5WlhSMWNtNGdibVY0ZER0Y2JpQWdJQ0FnSUNBZ0lDQWdJSDFjYmlBZ0lDQWdJQ0FnSUNCOVhHNWNiaUFnSUNBZ0lDQWdJQ0J1WlhoMExuWmhiSFZsSUQwZ2RXNWtaV1pwYm1Wa08xeHVJQ0FnSUNBZ0lDQWdJRzVsZUhRdVpHOXVaU0E5SUhSeWRXVTdYRzVjYmlBZ0lDQWdJQ0FnSUNCeVpYUjFjbTRnYm1WNGREdGNiaUFnSUNBZ0lDQWdmVHRjYmx4dUlDQWdJQ0FnSUNCeVpYUjFjbTRnYm1WNGRDNXVaWGgwSUQwZ2JtVjRkRHRjYmlBZ0lDQWdJSDFjYmlBZ0lDQjlYRzVjYmlBZ0lDQXZMeUJTWlhSMWNtNGdZVzRnYVhSbGNtRjBiM0lnZDJsMGFDQnVieUIyWVd4MVpYTXVYRzRnSUNBZ2NtVjBkWEp1SUhzZ2JtVjRkRG9nWkc5dVpWSmxjM1ZzZENCOU8xeHVJQ0I5WEc0Z0lHVjRjRzl5ZEhNdWRtRnNkV1Z6SUQwZ2RtRnNkV1Z6TzF4dVhHNGdJR1oxYm1OMGFXOXVJR1J2Ym1WU1pYTjFiSFFvS1NCN1hHNGdJQ0FnY21WMGRYSnVJSHNnZG1Gc2RXVTZJSFZ1WkdWbWFXNWxaQ3dnWkc5dVpUb2dkSEoxWlNCOU8xeHVJQ0I5WEc1Y2JpQWdRMjl1ZEdWNGRDNXdjbTkwYjNSNWNHVWdQU0I3WEc0Z0lDQWdZMjl1YzNSeWRXTjBiM0k2SUVOdmJuUmxlSFFzWEc1Y2JpQWdJQ0J5WlhObGREb2dablZ1WTNScGIyNG9jMnRwY0ZSbGJYQlNaWE5sZENrZ2UxeHVJQ0FnSUNBZ2RHaHBjeTV3Y21WMklEMGdNRHRjYmlBZ0lDQWdJSFJvYVhNdWJtVjRkQ0E5SURBN1hHNGdJQ0FnSUNBdkx5QlNaWE5sZEhScGJtY2dZMjl1ZEdWNGRDNWZjMlZ1ZENCbWIzSWdiR1ZuWVdONUlITjFjSEJ2Y25RZ2IyWWdRbUZpWld3bmMxeHVJQ0FnSUNBZ0x5OGdablZ1WTNScGIyNHVjMlZ1ZENCcGJYQnNaVzFsYm5SaGRHbHZiaTVjYmlBZ0lDQWdJSFJvYVhNdWMyVnVkQ0E5SUhSb2FYTXVYM05sYm5RZ1BTQjFibVJsWm1sdVpXUTdYRzRnSUNBZ0lDQjBhR2x6TG1SdmJtVWdQU0JtWVd4elpUdGNiaUFnSUNBZ0lIUm9hWE11WkdWc1pXZGhkR1VnUFNCdWRXeHNPMXh1WEc0Z0lDQWdJQ0IwYUdsekxtMWxkR2h2WkNBOUlGd2libVY0ZEZ3aU8xeHVJQ0FnSUNBZ2RHaHBjeTVoY21jZ1BTQjFibVJsWm1sdVpXUTdYRzVjYmlBZ0lDQWdJSFJvYVhNdWRISjVSVzUwY21sbGN5NW1iM0pGWVdOb0tISmxjMlYwVkhKNVJXNTBjbmtwTzF4dVhHNGdJQ0FnSUNCcFppQW9JWE5yYVhCVVpXMXdVbVZ6WlhRcElIdGNiaUFnSUNBZ0lDQWdabTl5SUNoMllYSWdibUZ0WlNCcGJpQjBhR2x6S1NCN1hHNGdJQ0FnSUNBZ0lDQWdMeThnVG05MElITjFjbVVnWVdKdmRYUWdkR2hsSUc5d2RHbHRZV3dnYjNKa1pYSWdiMllnZEdobGMyVWdZMjl1WkdsMGFXOXVjenBjYmlBZ0lDQWdJQ0FnSUNCcFppQW9ibUZ0WlM1amFHRnlRWFFvTUNrZ1BUMDlJRndpZEZ3aUlDWW1YRzRnSUNBZ0lDQWdJQ0FnSUNBZ0lHaGhjMDkzYmk1allXeHNLSFJvYVhNc0lHNWhiV1VwSUNZbVhHNGdJQ0FnSUNBZ0lDQWdJQ0FnSUNGcGMwNWhUaWdyYm1GdFpTNXpiR2xqWlNneEtTa3BJSHRjYmlBZ0lDQWdJQ0FnSUNBZ0lIUm9hWE5iYm1GdFpWMGdQU0IxYm1SbFptbHVaV1E3WEc0Z0lDQWdJQ0FnSUNBZ2ZWeHVJQ0FnSUNBZ0lDQjlYRzRnSUNBZ0lDQjlYRzRnSUNBZ2ZTeGNibHh1SUNBZ0lITjBiM0E2SUdaMWJtTjBhVzl1S0NrZ2UxeHVJQ0FnSUNBZ2RHaHBjeTVrYjI1bElEMGdkSEoxWlR0Y2JseHVJQ0FnSUNBZ2RtRnlJSEp2YjNSRmJuUnllU0E5SUhSb2FYTXVkSEo1Ulc1MGNtbGxjMXN3WFR0Y2JpQWdJQ0FnSUhaaGNpQnliMjkwVW1WamIzSmtJRDBnY205dmRFVnVkSEo1TG1OdmJYQnNaWFJwYjI0N1hHNGdJQ0FnSUNCcFppQW9jbTl2ZEZKbFkyOXlaQzUwZVhCbElEMDlQU0JjSW5Sb2NtOTNYQ0lwSUh0Y2JpQWdJQ0FnSUNBZ2RHaHliM2NnY205dmRGSmxZMjl5WkM1aGNtYzdYRzRnSUNBZ0lDQjlYRzVjYmlBZ0lDQWdJSEpsZEhWeWJpQjBhR2x6TG5KMllXdzdYRzRnSUNBZ2ZTeGNibHh1SUNBZ0lHUnBjM0JoZEdOb1JYaGpaWEIwYVc5dU9pQm1kVzVqZEdsdmJpaGxlR05sY0hScGIyNHBJSHRjYmlBZ0lDQWdJR2xtSUNoMGFHbHpMbVJ2Ym1VcElIdGNiaUFnSUNBZ0lDQWdkR2h5YjNjZ1pYaGpaWEIwYVc5dU8xeHVJQ0FnSUNBZ2ZWeHVYRzRnSUNBZ0lDQjJZWElnWTI5dWRHVjRkQ0E5SUhSb2FYTTdYRzRnSUNBZ0lDQm1kVzVqZEdsdmJpQm9ZVzVrYkdVb2JHOWpMQ0JqWVhWbmFIUXBJSHRjYmlBZ0lDQWdJQ0FnY21WamIzSmtMblI1Y0dVZ1BTQmNJblJvY205M1hDSTdYRzRnSUNBZ0lDQWdJSEpsWTI5eVpDNWhjbWNnUFNCbGVHTmxjSFJwYjI0N1hHNGdJQ0FnSUNBZ0lHTnZiblJsZUhRdWJtVjRkQ0E5SUd4dll6dGNibHh1SUNBZ0lDQWdJQ0JwWmlBb1kyRjFaMmgwS1NCN1hHNGdJQ0FnSUNBZ0lDQWdMeThnU1dZZ2RHaGxJR1JwYzNCaGRHTm9aV1FnWlhoalpYQjBhVzl1SUhkaGN5QmpZWFZuYUhRZ1lua2dZU0JqWVhSamFDQmliRzlqYXl4Y2JpQWdJQ0FnSUNBZ0lDQXZMeUIwYUdWdUlHeGxkQ0IwYUdGMElHTmhkR05vSUdKc2IyTnJJR2hoYm1Sc1pTQjBhR1VnWlhoalpYQjBhVzl1SUc1dmNtMWhiR3g1TGx4dUlDQWdJQ0FnSUNBZ0lHTnZiblJsZUhRdWJXVjBhRzlrSUQwZ1hDSnVaWGgwWENJN1hHNGdJQ0FnSUNBZ0lDQWdZMjl1ZEdWNGRDNWhjbWNnUFNCMWJtUmxabWx1WldRN1hHNGdJQ0FnSUNBZ0lIMWNibHh1SUNBZ0lDQWdJQ0J5WlhSMWNtNGdJU0VnWTJGMVoyaDBPMXh1SUNBZ0lDQWdmVnh1WEc0Z0lDQWdJQ0JtYjNJZ0tIWmhjaUJwSUQwZ2RHaHBjeTUwY25sRmJuUnlhV1Z6TG14bGJtZDBhQ0F0SURFN0lHa2dQajBnTURzZ0xTMXBLU0I3WEc0Z0lDQWdJQ0FnSUhaaGNpQmxiblJ5ZVNBOUlIUm9hWE11ZEhKNVJXNTBjbWxsYzF0cFhUdGNiaUFnSUNBZ0lDQWdkbUZ5SUhKbFkyOXlaQ0E5SUdWdWRISjVMbU52YlhCc1pYUnBiMjQ3WEc1Y2JpQWdJQ0FnSUNBZ2FXWWdLR1Z1ZEhKNUxuUnllVXh2WXlBOVBUMGdYQ0p5YjI5MFhDSXBJSHRjYmlBZ0lDQWdJQ0FnSUNBdkx5QkZlR05sY0hScGIyNGdkR2h5YjNkdUlHOTFkSE5wWkdVZ2IyWWdZVzU1SUhSeWVTQmliRzlqYXlCMGFHRjBJR052ZFd4a0lHaGhibVJzWlZ4dUlDQWdJQ0FnSUNBZ0lDOHZJR2wwTENCemJ5QnpaWFFnZEdobElHTnZiWEJzWlhScGIyNGdkbUZzZFdVZ2IyWWdkR2hsSUdWdWRHbHlaU0JtZFc1amRHbHZiaUIwYjF4dUlDQWdJQ0FnSUNBZ0lDOHZJSFJvY205M0lIUm9aU0JsZUdObGNIUnBiMjR1WEc0Z0lDQWdJQ0FnSUNBZ2NtVjBkWEp1SUdoaGJtUnNaU2hjSW1WdVpGd2lLVHRjYmlBZ0lDQWdJQ0FnZlZ4dVhHNGdJQ0FnSUNBZ0lHbG1JQ2hsYm5SeWVTNTBjbmxNYjJNZ1BEMGdkR2hwY3k1d2NtVjJLU0I3WEc0Z0lDQWdJQ0FnSUNBZ2RtRnlJR2hoYzBOaGRHTm9JRDBnYUdGelQzZHVMbU5oYkd3b1pXNTBjbmtzSUZ3aVkyRjBZMmhNYjJOY0lpazdYRzRnSUNBZ0lDQWdJQ0FnZG1GeUlHaGhjMFpwYm1Gc2JIa2dQU0JvWVhOUGQyNHVZMkZzYkNobGJuUnllU3dnWENKbWFXNWhiR3g1VEc5alhDSXBPMXh1WEc0Z0lDQWdJQ0FnSUNBZ2FXWWdLR2hoYzBOaGRHTm9JQ1ltSUdoaGMwWnBibUZzYkhrcElIdGNiaUFnSUNBZ0lDQWdJQ0FnSUdsbUlDaDBhR2x6TG5CeVpYWWdQQ0JsYm5SeWVTNWpZWFJqYUV4dll5a2dlMXh1SUNBZ0lDQWdJQ0FnSUNBZ0lDQnlaWFIxY200Z2FHRnVaR3hsS0dWdWRISjVMbU5oZEdOb1RHOWpMQ0IwY25WbEtUdGNiaUFnSUNBZ0lDQWdJQ0FnSUgwZ1pXeHpaU0JwWmlBb2RHaHBjeTV3Y21WMklEd2daVzUwY25rdVptbHVZV3hzZVV4dll5a2dlMXh1SUNBZ0lDQWdJQ0FnSUNBZ0lDQnlaWFIxY200Z2FHRnVaR3hsS0dWdWRISjVMbVpwYm1Gc2JIbE1iMk1wTzF4dUlDQWdJQ0FnSUNBZ0lDQWdmVnh1WEc0Z0lDQWdJQ0FnSUNBZ2ZTQmxiSE5sSUdsbUlDaG9ZWE5EWVhSamFDa2dlMXh1SUNBZ0lDQWdJQ0FnSUNBZ2FXWWdLSFJvYVhNdWNISmxkaUE4SUdWdWRISjVMbU5oZEdOb1RHOWpLU0I3WEc0Z0lDQWdJQ0FnSUNBZ0lDQWdJSEpsZEhWeWJpQm9ZVzVrYkdVb1pXNTBjbmt1WTJGMFkyaE1iMk1zSUhSeWRXVXBPMXh1SUNBZ0lDQWdJQ0FnSUNBZ2ZWeHVYRzRnSUNBZ0lDQWdJQ0FnZlNCbGJITmxJR2xtSUNob1lYTkdhVzVoYkd4NUtTQjdYRzRnSUNBZ0lDQWdJQ0FnSUNCcFppQW9kR2hwY3k1d2NtVjJJRHdnWlc1MGNua3VabWx1WVd4c2VVeHZZeWtnZTF4dUlDQWdJQ0FnSUNBZ0lDQWdJQ0J5WlhSMWNtNGdhR0Z1Wkd4bEtHVnVkSEo1TG1acGJtRnNiSGxNYjJNcE8xeHVJQ0FnSUNBZ0lDQWdJQ0FnZlZ4dVhHNGdJQ0FnSUNBZ0lDQWdmU0JsYkhObElIdGNiaUFnSUNBZ0lDQWdJQ0FnSUhSb2NtOTNJRzVsZHlCRmNuSnZjaWhjSW5SeWVTQnpkR0YwWlcxbGJuUWdkMmwwYUc5MWRDQmpZWFJqYUNCdmNpQm1hVzVoYkd4NVhDSXBPMXh1SUNBZ0lDQWdJQ0FnSUgxY2JpQWdJQ0FnSUNBZ2ZWeHVJQ0FnSUNBZ2ZWeHVJQ0FnSUgwc1hHNWNiaUFnSUNCaFluSjFjSFE2SUdaMWJtTjBhVzl1S0hSNWNHVXNJR0Z5WnlrZ2UxeHVJQ0FnSUNBZ1ptOXlJQ2gyWVhJZ2FTQTlJSFJvYVhNdWRISjVSVzUwY21sbGN5NXNaVzVuZEdnZ0xTQXhPeUJwSUQ0OUlEQTdJQzB0YVNrZ2UxeHVJQ0FnSUNBZ0lDQjJZWElnWlc1MGNua2dQU0IwYUdsekxuUnllVVZ1ZEhKcFpYTmJhVjA3WEc0Z0lDQWdJQ0FnSUdsbUlDaGxiblJ5ZVM1MGNubE1iMk1nUEQwZ2RHaHBjeTV3Y21WMklDWW1YRzRnSUNBZ0lDQWdJQ0FnSUNCb1lYTlBkMjR1WTJGc2JDaGxiblJ5ZVN3Z1hDSm1hVzVoYkd4NVRHOWpYQ0lwSUNZbVhHNGdJQ0FnSUNBZ0lDQWdJQ0IwYUdsekxuQnlaWFlnUENCbGJuUnllUzVtYVc1aGJHeDVURzlqS1NCN1hHNGdJQ0FnSUNBZ0lDQWdkbUZ5SUdacGJtRnNiSGxGYm5SeWVTQTlJR1Z1ZEhKNU8xeHVJQ0FnSUNBZ0lDQWdJR0p5WldGck8xeHVJQ0FnSUNBZ0lDQjlYRzRnSUNBZ0lDQjlYRzVjYmlBZ0lDQWdJR2xtSUNobWFXNWhiR3g1Ulc1MGNua2dKaVpjYmlBZ0lDQWdJQ0FnSUNBb2RIbHdaU0E5UFQwZ1hDSmljbVZoYTF3aUlIeDhYRzRnSUNBZ0lDQWdJQ0FnSUhSNWNHVWdQVDA5SUZ3aVkyOXVkR2x1ZFdWY0lpa2dKaVpjYmlBZ0lDQWdJQ0FnSUNCbWFXNWhiR3g1Ulc1MGNua3VkSEo1VEc5aklEdzlJR0Z5WnlBbUpseHVJQ0FnSUNBZ0lDQWdJR0Z5WnlBOFBTQm1hVzVoYkd4NVJXNTBjbmt1Wm1sdVlXeHNlVXh2WXlrZ2UxeHVJQ0FnSUNBZ0lDQXZMeUJKWjI1dmNtVWdkR2hsSUdacGJtRnNiSGtnWlc1MGNua2dhV1lnWTI5dWRISnZiQ0JwY3lCdWIzUWdhblZ0Y0dsdVp5QjBieUJoWEc0Z0lDQWdJQ0FnSUM4dklHeHZZMkYwYVc5dUlHOTFkSE5wWkdVZ2RHaGxJSFJ5ZVM5allYUmphQ0JpYkc5amF5NWNiaUFnSUNBZ0lDQWdabWx1WVd4c2VVVnVkSEo1SUQwZ2JuVnNiRHRjYmlBZ0lDQWdJSDFjYmx4dUlDQWdJQ0FnZG1GeUlISmxZMjl5WkNBOUlHWnBibUZzYkhsRmJuUnllU0EvSUdacGJtRnNiSGxGYm5SeWVTNWpiMjF3YkdWMGFXOXVJRG9nZTMwN1hHNGdJQ0FnSUNCeVpXTnZjbVF1ZEhsd1pTQTlJSFI1Y0dVN1hHNGdJQ0FnSUNCeVpXTnZjbVF1WVhKbklEMGdZWEpuTzF4dVhHNGdJQ0FnSUNCcFppQW9abWx1WVd4c2VVVnVkSEo1S1NCN1hHNGdJQ0FnSUNBZ0lIUm9hWE11YldWMGFHOWtJRDBnWENKdVpYaDBYQ0k3WEc0Z0lDQWdJQ0FnSUhSb2FYTXVibVY0ZENBOUlHWnBibUZzYkhsRmJuUnllUzVtYVc1aGJHeDVURzlqTzF4dUlDQWdJQ0FnSUNCeVpYUjFjbTRnUTI5dWRHbHVkV1ZUWlc1MGFXNWxiRHRjYmlBZ0lDQWdJSDFjYmx4dUlDQWdJQ0FnY21WMGRYSnVJSFJvYVhNdVkyOXRjR3hsZEdVb2NtVmpiM0prS1R0Y2JpQWdJQ0I5TEZ4dVhHNGdJQ0FnWTI5dGNHeGxkR1U2SUdaMWJtTjBhVzl1S0hKbFkyOXlaQ3dnWVdaMFpYSk1iMk1wSUh0Y2JpQWdJQ0FnSUdsbUlDaHlaV052Y21RdWRIbHdaU0E5UFQwZ1hDSjBhSEp2ZDF3aUtTQjdYRzRnSUNBZ0lDQWdJSFJvY205M0lISmxZMjl5WkM1aGNtYzdYRzRnSUNBZ0lDQjlYRzVjYmlBZ0lDQWdJR2xtSUNoeVpXTnZjbVF1ZEhsd1pTQTlQVDBnWENKaWNtVmhhMXdpSUh4OFhHNGdJQ0FnSUNBZ0lDQWdjbVZqYjNKa0xuUjVjR1VnUFQwOUlGd2lZMjl1ZEdsdWRXVmNJaWtnZTF4dUlDQWdJQ0FnSUNCMGFHbHpMbTVsZUhRZ1BTQnlaV052Y21RdVlYSm5PMXh1SUNBZ0lDQWdmU0JsYkhObElHbG1JQ2h5WldOdmNtUXVkSGx3WlNBOVBUMGdYQ0p5WlhSMWNtNWNJaWtnZTF4dUlDQWdJQ0FnSUNCMGFHbHpMbkoyWVd3Z1BTQjBhR2x6TG1GeVp5QTlJSEpsWTI5eVpDNWhjbWM3WEc0Z0lDQWdJQ0FnSUhSb2FYTXViV1YwYUc5a0lEMGdYQ0p5WlhSMWNtNWNJanRjYmlBZ0lDQWdJQ0FnZEdocGN5NXVaWGgwSUQwZ1hDSmxibVJjSWp0Y2JpQWdJQ0FnSUgwZ1pXeHpaU0JwWmlBb2NtVmpiM0prTG5SNWNHVWdQVDA5SUZ3aWJtOXliV0ZzWENJZ0ppWWdZV1owWlhKTWIyTXBJSHRjYmlBZ0lDQWdJQ0FnZEdocGN5NXVaWGgwSUQwZ1lXWjBaWEpNYjJNN1hHNGdJQ0FnSUNCOVhHNWNiaUFnSUNBZ0lISmxkSFZ5YmlCRGIyNTBhVzUxWlZObGJuUnBibVZzTzF4dUlDQWdJSDBzWEc1Y2JpQWdJQ0JtYVc1cGMyZzZJR1oxYm1OMGFXOXVLR1pwYm1Gc2JIbE1iMk1wSUh0Y2JpQWdJQ0FnSUdadmNpQW9kbUZ5SUdrZ1BTQjBhR2x6TG5SeWVVVnVkSEpwWlhNdWJHVnVaM1JvSUMwZ01Uc2dhU0ErUFNBd095QXRMV2twSUh0Y2JpQWdJQ0FnSUNBZ2RtRnlJR1Z1ZEhKNUlEMGdkR2hwY3k1MGNubEZiblJ5YVdWelcybGRPMXh1SUNBZ0lDQWdJQ0JwWmlBb1pXNTBjbmt1Wm1sdVlXeHNlVXh2WXlBOVBUMGdabWx1WVd4c2VVeHZZeWtnZTF4dUlDQWdJQ0FnSUNBZ0lIUm9hWE11WTI5dGNHeGxkR1VvWlc1MGNua3VZMjl0Y0d4bGRHbHZiaXdnWlc1MGNua3VZV1owWlhKTWIyTXBPMXh1SUNBZ0lDQWdJQ0FnSUhKbGMyVjBWSEo1Ulc1MGNua29aVzUwY25rcE8xeHVJQ0FnSUNBZ0lDQWdJSEpsZEhWeWJpQkRiMjUwYVc1MVpWTmxiblJwYm1Wc08xeHVJQ0FnSUNBZ0lDQjlYRzRnSUNBZ0lDQjlYRzRnSUNBZ2ZTeGNibHh1SUNBZ0lGd2lZMkYwWTJoY0lqb2dablZ1WTNScGIyNG9kSEo1VEc5aktTQjdYRzRnSUNBZ0lDQm1iM0lnS0haaGNpQnBJRDBnZEdocGN5NTBjbmxGYm5SeWFXVnpMbXhsYm1kMGFDQXRJREU3SUdrZ1BqMGdNRHNnTFMxcEtTQjdYRzRnSUNBZ0lDQWdJSFpoY2lCbGJuUnllU0E5SUhSb2FYTXVkSEo1Ulc1MGNtbGxjMXRwWFR0Y2JpQWdJQ0FnSUNBZ2FXWWdLR1Z1ZEhKNUxuUnllVXh2WXlBOVBUMGdkSEo1VEc5aktTQjdYRzRnSUNBZ0lDQWdJQ0FnZG1GeUlISmxZMjl5WkNBOUlHVnVkSEo1TG1OdmJYQnNaWFJwYjI0N1hHNGdJQ0FnSUNBZ0lDQWdhV1lnS0hKbFkyOXlaQzUwZVhCbElEMDlQU0JjSW5Sb2NtOTNYQ0lwSUh0Y2JpQWdJQ0FnSUNBZ0lDQWdJSFpoY2lCMGFISnZkMjRnUFNCeVpXTnZjbVF1WVhKbk8xeHVJQ0FnSUNBZ0lDQWdJQ0FnY21WelpYUlVjbmxGYm5SeWVTaGxiblJ5ZVNrN1hHNGdJQ0FnSUNBZ0lDQWdmVnh1SUNBZ0lDQWdJQ0FnSUhKbGRIVnliaUIwYUhKdmQyNDdYRzRnSUNBZ0lDQWdJSDFjYmlBZ0lDQWdJSDFjYmx4dUlDQWdJQ0FnTHk4Z1ZHaGxJR052Ym5SbGVIUXVZMkYwWTJnZ2JXVjBhRzlrSUcxMWMzUWdiMjVzZVNCaVpTQmpZV3hzWldRZ2QybDBhQ0JoSUd4dlkyRjBhVzl1WEc0Z0lDQWdJQ0F2THlCaGNtZDFiV1Z1ZENCMGFHRjBJR052Y25KbGMzQnZibVJ6SUhSdklHRWdhMjV2ZDI0Z1kyRjBZMmdnWW14dlkyc3VYRzRnSUNBZ0lDQjBhSEp2ZHlCdVpYY2dSWEp5YjNJb1hDSnBiR3hsWjJGc0lHTmhkR05vSUdGMGRHVnRjSFJjSWlrN1hHNGdJQ0FnZlN4Y2JseHVJQ0FnSUdSbGJHVm5ZWFJsV1dsbGJHUTZJR1oxYm1OMGFXOXVLR2wwWlhKaFlteGxMQ0J5WlhOMWJIUk9ZVzFsTENCdVpYaDBURzlqS1NCN1hHNGdJQ0FnSUNCMGFHbHpMbVJsYkdWbllYUmxJRDBnZTF4dUlDQWdJQ0FnSUNCcGRHVnlZWFJ2Y2pvZ2RtRnNkV1Z6S0dsMFpYSmhZbXhsS1N4Y2JpQWdJQ0FnSUNBZ2NtVnpkV3gwVG1GdFpUb2djbVZ6ZFd4MFRtRnRaU3hjYmlBZ0lDQWdJQ0FnYm1WNGRFeHZZem9nYm1WNGRFeHZZMXh1SUNBZ0lDQWdmVHRjYmx4dUlDQWdJQ0FnYVdZZ0tIUm9hWE11YldWMGFHOWtJRDA5UFNCY0ltNWxlSFJjSWlrZ2UxeHVJQ0FnSUNBZ0lDQXZMeUJFWld4cFltVnlZWFJsYkhrZ1ptOXlaMlYwSUhSb1pTQnNZWE4wSUhObGJuUWdkbUZzZFdVZ2MyOGdkR2hoZENCM1pTQmtiMjRuZEZ4dUlDQWdJQ0FnSUNBdkx5QmhZMk5wWkdWdWRHRnNiSGtnY0dGemN5QnBkQ0J2YmlCMGJ5QjBhR1VnWkdWc1pXZGhkR1V1WEc0Z0lDQWdJQ0FnSUhSb2FYTXVZWEpuSUQwZ2RXNWtaV1pwYm1Wa08xeHVJQ0FnSUNBZ2ZWeHVYRzRnSUNBZ0lDQnlaWFIxY200Z1EyOXVkR2x1ZFdWVFpXNTBhVzVsYkR0Y2JpQWdJQ0I5WEc0Z0lIMDdYRzVjYmlBZ0x5OGdVbVZuWVhKa2JHVnpjeUJ2WmlCM2FHVjBhR1Z5SUhSb2FYTWdjMk55YVhCMElHbHpJR1Y0WldOMWRHbHVaeUJoY3lCaElFTnZiVzF2YmtwVElHMXZaSFZzWlZ4dUlDQXZMeUJ2Y2lCdWIzUXNJSEpsZEhWeWJpQjBhR1VnY25WdWRHbHRaU0J2WW1wbFkzUWdjMjhnZEdoaGRDQjNaU0JqWVc0Z1pHVmpiR0Z5WlNCMGFHVWdkbUZ5YVdGaWJHVmNiaUFnTHk4Z2NtVm5aVzVsY21GMGIzSlNkVzUwYVcxbElHbHVJSFJvWlNCdmRYUmxjaUJ6WTI5d1pTd2dkMmhwWTJnZ1lXeHNiM2R6SUhSb2FYTWdiVzlrZFd4bElIUnZJR0psWEc0Z0lDOHZJR2x1YW1WamRHVmtJR1ZoYzJsc2VTQmllU0JnWW1sdUwzSmxaMlZ1WlhKaGRHOXlJQzB0YVc1amJIVmtaUzF5ZFc1MGFXMWxJSE5qY21sd2RDNXFjMkF1WEc0Z0lISmxkSFZ5YmlCbGVIQnZjblJ6TzF4dVhHNTlLRnh1SUNBdkx5QkpaaUIwYUdseklITmpjbWx3ZENCcGN5QmxlR1ZqZFhScGJtY2dZWE1nWVNCRGIyMXRiMjVLVXlCdGIyUjFiR1VzSUhWelpTQnRiMlIxYkdVdVpYaHdiM0owYzF4dUlDQXZMeUJoY3lCMGFHVWdjbVZuWlc1bGNtRjBiM0pTZFc1MGFXMWxJRzVoYldWemNHRmpaUzRnVDNSb1pYSjNhWE5sSUdOeVpXRjBaU0JoSUc1bGR5QmxiWEIwZVZ4dUlDQXZMeUJ2WW1wbFkzUXVJRVZwZEdobGNpQjNZWGtzSUhSb1pTQnlaWE4xYkhScGJtY2diMkpxWldOMElIZHBiR3dnWW1VZ2RYTmxaQ0IwYnlCcGJtbDBhV0ZzYVhwbFhHNGdJQzh2SUhSb1pTQnlaV2RsYm1WeVlYUnZjbEoxYm5ScGJXVWdkbUZ5YVdGaWJHVWdZWFFnZEdobElIUnZjQ0J2WmlCMGFHbHpJR1pwYkdVdVhHNGdJSFI1Y0dWdlppQnRiMlIxYkdVZ1BUMDlJRndpYjJKcVpXTjBYQ0lnUHlCdGIyUjFiR1V1Wlhod2IzSjBjeUE2SUh0OVhHNHBLVHRjYmx4dWRISjVJSHRjYmlBZ2NtVm5aVzVsY21GMGIzSlNkVzUwYVcxbElEMGdjblZ1ZEdsdFpUdGNibjBnWTJGMFkyZ2dLR0ZqWTJsa1pXNTBZV3hUZEhKcFkzUk5iMlJsS1NCN1hHNGdJQzh2SUZSb2FYTWdiVzlrZFd4bElITm9iM1ZzWkNCdWIzUWdZbVVnY25WdWJtbHVaeUJwYmlCemRISnBZM1FnYlc5a1pTd2djMjhnZEdobElHRmliM1psWEc0Z0lDOHZJR0Z6YzJsbmJtMWxiblFnYzJodmRXeGtJR0ZzZDJGNWN5QjNiM0pySUhWdWJHVnpjeUJ6YjIxbGRHaHBibWNnYVhNZ2JXbHpZMjl1Wm1sbmRYSmxaQzRnU25WemRGeHVJQ0F2THlCcGJpQmpZWE5sSUhKMWJuUnBiV1V1YW5NZ1lXTmphV1JsYm5SaGJHeDVJSEoxYm5NZ2FXNGdjM1J5YVdOMElHMXZaR1VzSUhkbElHTmhiaUJsYzJOaGNHVmNiaUFnTHk4Z2MzUnlhV04wSUcxdlpHVWdkWE5wYm1jZ1lTQm5iRzlpWVd3Z1JuVnVZM1JwYjI0Z1kyRnNiQzRnVkdocGN5QmpiM1ZzWkNCamIyNWpaV2wyWVdKc2VTQm1ZV2xzWEc0Z0lDOHZJR2xtSUdFZ1EyOXVkR1Z1ZENCVFpXTjFjbWwwZVNCUWIyeHBZM2tnWm05eVltbGtjeUIxYzJsdVp5QkdkVzVqZEdsdmJpd2dZblYwSUdsdUlIUm9ZWFFnWTJGelpWeHVJQ0F2THlCMGFHVWdjSEp2Y0dWeUlITnZiSFYwYVc5dUlHbHpJSFJ2SUdacGVDQjBhR1VnWVdOamFXUmxiblJoYkNCemRISnBZM1FnYlc5a1pTQndjbTlpYkdWdExpQkpabHh1SUNBdkx5QjViM1VuZG1VZ2JXbHpZMjl1Wm1sbmRYSmxaQ0I1YjNWeUlHSjFibVJzWlhJZ2RHOGdabTl5WTJVZ2MzUnlhV04wSUcxdlpHVWdZVzVrSUdGd2NHeHBaV1FnWVZ4dUlDQXZMeUJEVTFBZ2RHOGdabTl5WW1sa0lFWjFibU4wYVc5dUxDQmhibVFnZVc5MUozSmxJRzV2ZENCM2FXeHNhVzVuSUhSdklHWnBlQ0JsYVhSb1pYSWdiMllnZEdodmMyVmNiaUFnTHk4Z2NISnZZbXhsYlhNc0lIQnNaV0Z6WlNCa1pYUmhhV3dnZVc5MWNpQjFibWx4ZFdVZ2NISmxaR2xqWVcxbGJuUWdhVzRnWVNCSGFYUklkV0lnYVhOemRXVXVYRzRnSUVaMWJtTjBhVzl1S0Z3aWNsd2lMQ0JjSW5KbFoyVnVaWEpoZEc5eVVuVnVkR2x0WlNBOUlISmNJaWtvY25WdWRHbHRaU2s3WEc1OVhHNGlMQ0pqYjI1emRDQnlaV2RsYm1WeVlYUnZjbEoxYm5ScGJXVWdQU0J5WlhGMWFYSmxLRndpY21WblpXNWxjbUYwYjNJdGNuVnVkR2x0WlZ3aUtUdGNjbHh1WEhKY2JtTnZibk4wSUhSdmNHeHBibVVnUFNCa2IyTjFiV1Z1ZEM1eGRXVnllVk5sYkdWamRHOXlLRndpTG0xbGJuVmNJaWs3WEhKY2JtTnZibk4wSUcxdlltbHNaVTFsYm5VZ1BTQmtiMk4xYldWdWRDNW5aWFJGYkdWdFpXNTBRbmxKWkNoY0ltMXZZbWxzWlUxbGJuVmNJaWs3WEhKY2JtTnZibk4wSUdOc2IzTmxRblJ1SUQwZ1pHOWpkVzFsYm5RdVoyVjBSV3hsYldWdWRFSjVTV1FvWENKamJHOXpaVUowYmx3aUtUdGNjbHh1WTI5dWMzUWdZblZ5WjJWeUlEMGdaRzlqZFcxbGJuUXVaMlYwUld4bGJXVnVkRUo1U1dRb1hDSmlkWEpuWlhKY0lpazdYSEpjYm1OdmJuTjBJRzF2WW1sc1pVeHBjM1FnUFNCa2IyTjFiV1Z1ZEM1blpYUkZiR1Z0Wlc1MFFubEpaQ2hjSW0xdlltbHNaVXhwYzNSY0lpazdYSEpjYm1OdmJuTjBJSE5sWlUxdmNtVWdQU0JrYjJOMWJXVnVkQzVuWlhSRmJHVnRaVzUwUW5sSlpDaGNJbk5sWlUxdmNtVmNJaWs3WEhKY2JtTnZibk4wSUdGalkyOXlaR1Z2YmlBOUlHUnZZM1Z0Wlc1MExtZGxkRVZzWlcxbGJuUkNlVWxrS0Z3aVlXTmpiM0prWlc5dVhDSXBPMXh5WEc1amIyNXpkQ0J5WldGa1RXOXlaVEVnUFNCa2IyTjFiV1Z1ZEM1blpYUkZiR1Z0Wlc1MFFubEpaQ2hjSW5KbFlXUk5iM0psTVZ3aUtUdGNjbHh1WTI5dWMzUWdjbVZoWkUxdmNtVXlJRDBnWkc5amRXMWxiblF1WjJWMFJXeGxiV1Z1ZEVKNVNXUW9YQ0p5WldGa1RXOXlaVEpjSWlrN1hISmNibU52Ym5OMElISmxZV1JNWlhOek1TQTlJR1J2WTNWdFpXNTBMbWRsZEVWc1pXMWxiblJDZVVsa0tGd2ljbVZoWkV4bGMzTXhYQ0lwTzF4eVhHNWpiMjV6ZENCeVpXRmtUR1Z6Y3pJZ1BTQmtiMk4xYldWdWRDNW5aWFJGYkdWdFpXNTBRbmxKWkNoY0luSmxZV1JNWlhOek1sd2lLVHRjY2x4dVkyOXVjM1FnYkdsemRFWnBjbk4wSUQwZ1pHOWpkVzFsYm5RdVoyVjBSV3hsYldWdWRFSjVTV1FvWENKc2FYTjBSbWx5YzNSY0lpazdYSEpjYm1OdmJuTjBJSFJsZUhSR2FYSnpkQ0E5SUdSdlkzVnRaVzUwTG1kbGRFVnNaVzFsYm5SQ2VVbGtLRndpZEdWNGRFWnBjbk4wWENJcE8xeHlYRzVqYjI1emRDQjBaWGgwVTJWamIyNWtJRDBnWkc5amRXMWxiblF1WjJWMFJXeGxiV1Z1ZEVKNVNXUW9YQ0owWlhoMFUyVmpiMjVrWENJcE8xeHlYRzVqYjI1emRDQmpZWEprY3lBOUlHUnZZM1Z0Wlc1MExtZGxkRVZzWlcxbGJuUkNlVWxrS0Z3aVkyRnlaSE5jSWlrN1hISmNibU52Ym5OMElHTmhjbVJCWTNScGRtVWdQU0JrYjJOMWJXVnVkQzVuWlhSRmJHVnRaVzUwUW5sSlpDaGNJbU5oY21SQlkzUnBkbVZjSWlrN1hISmNibXhsZENCamIzVnVkR1Z5SUQwZ016dGNjbHh1YkdWMElISmhhWE5sY2lBOUlETTdYSEpjYm1OdmJuTjBJSEJ5YjJSMVkzUnpJRDBnVzF4eVhHNGdJSHRjY2x4dUlDQWdJSE55WXpvZ1hDSnBiV2N2TVM0Z1NXNWtiMjl5TG1wd1oxd2lMRnh5WEc0Z0lDQWdjM1ZpZEdsMGJHVTZJRndpU1c1a2IyOXlJR1Z1WlhKbmVTQnpaWEoyYVdObGMxd2lMRnh5WEc0Z0lDQWdkR1Y0ZERwY2NseHVJQ0FnSUNBZ1hDSlhaU0JvWld4d1pXUWdTVzVrYjI5eUlHVnVaWEpuZVNCelpYSjJhV05sY3lCMGJ5Qm5jbVZoZEhrZ2MybHRjR3hwWm5rZ2RHaGxhWElnWTJGelpTQnRZVzVoWjJWdFpXNTBJSE41YzNSbGJTNHVMbHdpWEhKY2JpQWdmU3hjY2x4dUlDQjdYSEpjYmlBZ0lDQnpjbU02SUZ3aWFXMW5Mekl1SUVKcGNtUnBaUzVxY0dkY0lpeGNjbHh1SUNBZ0lITjFZblJwZEd4bE9pQmNJa0pwY21ScFpTQkhiMnhrSUZSdmRYSnpYQ0lzWEhKY2JpQWdJQ0IwWlhoME9seHlYRzRnSUNBZ0lDQmNJbGRsSUdobGJIQmxaQ0JDYVhKa2VTQkhiMnhtSUZSdmRYSnpJSFJ2SUhOMFlYa2djbVZzWlhabFlXNTBJRzl1SUdGdUlHbHVZMnh5WldGemFXNW5iSGtnWTI5dGNHVjBhWFJwZG1VZ2JXRnlhMlYwTGk0dVhDSmNjbHh1SUNCOUxGeHlYRzRnSUh0Y2NseHVJQ0FnSUhOeVl6b2dYQ0pwYldjdk15NGdUbTkzVjJobGNtVXVhbkJuWENJc1hISmNiaUFnSUNCemRXSjBhWFJzWlRvZ1hDSk9iM2RYYUdWeVpWd2lMRnh5WEc0Z0lDQWdkR1Y0ZERwY2NseHVJQ0FnSUNBZ1hDSlhaU0JpZFdsc2RDQmhJSEpsWTI5dGJXVnVaR0YwYVc5dWN5QmhjSEFnWm05eUlIQmxiM0JzWlNCM2IzSnJhVzVuSUdsdUlHTnlaV0YwYVhabElHbHVaSFZ6ZEhKcFpYTXVMaTVjSWx4eVhHNGdJSDBzWEhKY2JpQWdlMXh5WEc0Z0lDQWdjM0pqT2lCY0ltbHRaeTgwTGlCR2VXNWthWEZ6ZG1GcWNHVnVMbXB3WjF3aUxGeHlYRzRnSUNBZ2MzVmlkR2wwYkdVNklGd2lSbmx1WkdseGMzWmhhbkJsYmx3aUxGeHlYRzRnSUNBZ2RHVjRkRHBjY2x4dUlDQWdJQ0FnWENKWFpTQmpjbVZoZEdWa0lHRnVJR0Z3Y0NCMGFHRjBJR2hsYkhCbFpDQmpkWE4wYjIxbGNuTWdabWx1WkNCbmFXWjBjeUJoYlc5dVp5QnRiM0psSUhSb1lXNGdNamt3TURBd01DQnBkR1Z0Y3k0dUxsd2lYSEpjYmlBZ2ZTeGNjbHh1SUNCN1hISmNiaUFnSUNCemNtTTZJRndpYVcxbkx6VXVJRUo1ZEdocWRXd3VhbkJuWENJc1hISmNiaUFnSUNCemRXSjBhWFJzWlRvZ1hDSkNlWFJvYW5Wc1hDSXNYSEpjYmlBZ0lDQjBaWGgwT2x4eVhHNGdJQ0FnSUNCY0lsZGxJR055WldGMFpXUWdkR2x5WlNCbVlYTm9hVzl1SUdadmNpQjBhR1VnYVc1amNtVmhjMmx1WjJ4NUlHVm5ZV3hwZEdGeWFXRnVJR05oY2lCdFlXbHVkR2x1WVdObElHMWhjbXRsZEM0dUxsd2lYSEpjYmlBZ2ZTeGNjbHh1SUNCN1hISmNiaUFnSUNCemNtTTZJRndpYVcxbkx6WXVJRlJwWTJ0cGJpNXFjR2RjSWl4Y2NseHVJQ0FnSUhOMVluUnBkR3hsT2lCY0lsUnBZMnRwYmx3aUxGeHlYRzRnSUNBZ2RHVjRkRHBjY2x4dUlDQWdJQ0FnWENKWFpTQnBiblpsYm5SbFpDQmhJSFJwYldVZ2NtVndiM0owYVc1bklITjVjM1JsYlNCbWIzSWdjR1Z2Y0d4bElIZG9ieUJvWVhSbElIUnBiV1VnZEhKaFkydHBibWN1TGk1Y0lseHlYRzRnSUgwc1hISmNiaUFnZTF4eVhHNGdJQ0FnYzNKak9pQmNJbWx0Wnk4M0xpQlZZbVZ5YldWa2N5NXFjR2RjSWl4Y2NseHVJQ0FnSUhOMVluUnBkR3hsT2lCY0lsVmlaWEp0WldSelhDSXNYSEpjYmlBZ0lDQjBaWGgwT2x4eVhHNGdJQ0FnSUNCY0lsZGxJR055WldGMFpXUWdZVzRnWVhCd0lIUm9ZWFFnYUdWc2NHVmtJR04xYzNSdmJXVnljeUJtYVc1a0lHZHBablJ6SUdGdGIyNW5JRzF2Y21VZ2RHaGhiaUF5T1RBd01EQXdJR2wwWlcxekxpNHVYQ0pjY2x4dUlDQjlMRnh5WEc0Z0lIdGNjbHh1SUNBZ0lITnlZem9nWENKcGJXY3ZPQzRnVnNPa2MzUjBjbUZtYVdzZ1EyRnNZM1ZzWVhSdmNpNXFjR2RjSWl4Y2NseHVJQ0FnSUhOMVluUnBkR3hsT2lCY0lsYkRwSE4wZEhKaFptbHJJRU5oYkdOMWJHRjBiM0pjSWl4Y2NseHVJQ0FnSUhSbGVIUTZYSEpjYmlBZ0lDQWdJRndpVjJVZ1kzSmxZWFJsWkNCMGFYSmxJR1poYzJocGIyNGdabTl5SUhSb1pTQnBibU55WldGemFXNW5iSGtnWldkaGJHbDBZWEpwWVc0Z1kyRnlJRzFoYVc1MGFXNWhZMlVnYldGeWEyVjBMaTR1WENKY2NseHVJQ0I5TEZ4eVhHNGdJSHRjY2x4dUlDQWdJSE55WXpvZ1hDSnBiV2N2T1M0Z1ZITERwRzVwYm1kemNHRnlkRzVsY2k1cWNHZGNJaXhjY2x4dUlDQWdJSE4xWW5ScGRHeGxPaUJjSWxSeXc2UnVhVzVuYzNCaGNuUnVaWEpjSWl4Y2NseHVJQ0FnSUhSbGVIUTZYSEpjYmlBZ0lDQWdJRndpVjJVZ2FXNTJaVzUwWldRZ1lTQjBhVzFsSUhKbGNHOXlkR2x1WnlCemVYTjBaVzBnWm05eUlIQmxiM0JzWlNCM2FHOGdhR0YwWlNCMGFXMWxJSFJ5WVdOcmFXNW5MaTR1WENKY2NseHVJQ0I5WEhKY2JsMDdYSEpjYmx4eVhHNWtiMk4xYldWdWRDNWhaR1JGZG1WdWRFeHBjM1JsYm1WeUtGd2ljMk55YjJ4c1hDSXNJQ2dwSUQwK0lIdGNjbHh1SUNCcFppQW9kMmx1Wkc5M0xuQmhaMlZaVDJabWMyVjBJRHdnZEc5d2JHbHVaUzVqYkdsbGJuUklaV2xuYUhRcElIdGNjbHh1SUNBZ0lIUnZjR3hwYm1VdVkyeGhjM05NYVhOMExuSmxiVzkyWlNoY0ltWnBlR1ZrWENJcE8xeHlYRzRnSUgwZ1pXeHpaU0I3WEhKY2JpQWdJQ0IwYjNCc2FXNWxMbU5zWVhOelRHbHpkQzVoWkdRb1hDSm1hWGhsWkZ3aUtUdGNjbHh1SUNCOVhISmNibjBwTzF4eVhHNWNjbHh1WW5WeVoyVnlMbTl1WTJ4cFkyc2dQU0JsSUQwK0lIdGNjbHh1SUNCbExuQnlaWFpsYm5SRVpXWmhkV3gwS0NrN1hISmNiaUFnYlc5aWFXeGxUV1Z1ZFM1amJHRnpjMHhwYzNRdWRHOW5aMnhsS0Z3aWFHbGtaVndpS1R0Y2NseHVmVHRjY2x4dVhISmNibU5zYjNObFFuUnVMbTl1WTJ4cFkyc2dQU0JsSUQwK0lIdGNjbHh1SUNCbExuQnlaWFpsYm5SRVpXWmhkV3gwS0NrN1hISmNiaUFnYlc5aWFXeGxUV1Z1ZFM1amJHRnpjMHhwYzNRdWRHOW5aMnhsS0Z3aWFHbGtaVndpS1R0Y2NseHVmVHRjY2x4dVhISmNibTF2WW1sc1pVeHBjM1F1YjI1amJHbGpheUE5SUNncElEMCtJSHRjY2x4dUlDQnRiMkpwYkdWTlpXNTFMbU5zWVhOelRHbHpkQzUwYjJkbmJHVW9YQ0pvYVdSbFhDSXBPMXh5WEc1OU8xeHlYRzVjY2x4dVlXTmpiM0prWlc5dUxtRmtaRVYyWlc1MFRHbHpkR1Z1WlhJb1hDSmpiR2xqYTF3aUxDQmxJRDArSUh0Y2NseHVJQ0JzWlhRZ2RHRnlaMlYwSUQwZ1pTNTBZWEpuWlhRN1hISmNiaUFnWTI5dWMzUWdiR2x6ZENBOUlHUnZZM1Z0Wlc1MExtZGxkRVZzWlcxbGJuUnpRbmxEYkdGemMwNWhiV1VvWENKb2IzY3RkMlV0Wkc5ZlgzUmhZbXhsZEMxcGRHVnRYQ0lwTzF4eVhHNGdJR3hsZENCaGNuSWdQU0JiTGk0dWJHbHpkRjA3WEhKY2JpQWdhV1lnS0hSaGNtZGxkQzVqYkdGemMweHBjM1F1WTI5dWRHRnBibk1vSjNOb2IzY25LU2tnZTF4eVhHNGdJQ0FnZEdGeVoyVjBMbU5zWVhOelRHbHpkQzUwYjJkbmJHVW9YQ0p6YUc5M1hDSXBPMXh5WEc0Z0lIMGdaV3h6WlNCN1hISmNiaUFnSUNCaGNuSXViV0Z3S0drZ1BUNGdhUzVqYkdGemMweHBjM1F1Y21WdGIzWmxLRndpYzJodmQxd2lLU2s3WEhKY2JpQWdJQ0IwWVhKblpYUXVZMnhoYzNOTWFYTjBMblJ2WjJkc1pTaGNJbk5vYjNkY0lpazdYSEpjYmlBZ2ZWeHlYRzU5S1R0Y2NseHVYSEpjYm1OaGNtUnpMbUZrWkVWMlpXNTBUR2x6ZEdWdVpYSW9YQ0p0YjNWelpXOTJaWEpjSWl3Z1pTQTlQaUI3WEhKY2JpQWdZMjl1YzNRZ2RHRnlaMlYwSUQwZ1pTNTBZWEpuWlhRN1hISmNiaUFnWTI5dWMzUWdZMmhwYkdSeklEMGdZMkZ5WkhNdVkyaHBiR1J5Wlc0N1hISmNiaUFnYVdZb2RHRnlaMlYwTG1Oc1lYTnpUR2x6ZEM1amIyNTBZV2x1Y3lnbmJXVjBhRzlrYzE5ZlkyRnlaQ2NwS1NCN1hISmNiaUFnSUNCbWIzSWdLR3hsZENCcFBUQXNJR05vYVd4a095QmphR2xzWkNBOUlHTm9hV3hrYzF0cFhUc2dhU3NyS1NCN1hISmNiaUFnSUNBZ0lHTm9hV3hrTG1Oc1lYTnpUR2x6ZEM1eVpXMXZkbVVvSjJGamRHbDJaU2NwWEhKY2JpQWdJQ0I5WEhKY2JpQWdJQ0IwWVhKblpYUXVZMnhoYzNOTWFYTjBMbUZrWkNnbllXTjBhWFpsSnlrN1hISmNiaUFnZlNCbGJITmxJSEpsZEhWeWJseHlYRzU5S1R0Y2NseHVYSEpjYm5KbFlXUk5iM0psTVM1dmJtTnNhV05ySUQwZ0tDa2dQVDRnZTF4eVhHNGdJR3hwYzNSR2FYSnpkQzVqYkdGemMweHBjM1F1ZEc5bloyeGxLRndpYlc5eVpWd2lLVHRjY2x4dUlDQjBaWGgwUm1seWMzUXVZMnhoYzNOTWFYTjBMblJ2WjJkc1pTaGNJbTF2Y21WY0lpazdYSEpjYmlBZ2NtVmhaRTF2Y21VeExtTnNZWE56VEdsemRDNTBiMmRuYkdVb1hDSm9hV1JrWlc1Y0lpazdYSEpjYmlBZ2NtVmhaRXhsYzNNeExtTnNZWE56VEdsemRDNTBiMmRuYkdVb1hDSm9hV1JrWlc1Y0lpazdYSEpjYm4wN1hISmNibHh5WEc1eVpXRmtUR1Z6Y3pFdWIyNWpiR2xqYXlBOUlDZ3BJRDArSUh0Y2NseHVJQ0JzYVhOMFJtbHljM1F1WTJ4aGMzTk1hWE4wTG5SdloyZHNaU2hjSW0xdmNtVmNJaWs3WEhKY2JpQWdkR1Y0ZEVacGNuTjBMbU5zWVhOelRHbHpkQzUwYjJkbmJHVW9YQ0p0YjNKbFhDSXBPMXh5WEc0Z0lISmxZV1JOYjNKbE1TNWpiR0Z6YzB4cGMzUXVkRzluWjJ4bEtGd2lhR2xrWkdWdVhDSXBPMXh5WEc0Z0lISmxZV1JNWlhOek1TNWpiR0Z6YzB4cGMzUXVkRzluWjJ4bEtGd2lhR2xrWkdWdVhDSXBPMXh5WEc1OU8xeHlYRzVjY2x4dWNtVmhaRTF2Y21VeUxtOXVZMnhwWTJzZ1BTQW9LU0E5UGlCN1hISmNiaUFnZEdWNGRGTmxZMjl1WkM1amJHRnpjMHhwYzNRdWRHOW5aMnhsS0Z3aWJXOXlaVndpS1R0Y2NseHVJQ0J5WldGa1RXOXlaVEl1WTJ4aGMzTk1hWE4wTG5SdloyZHNaU2hjSW1ocFpHUmxibHdpS1R0Y2NseHVJQ0J5WldGa1RHVnpjekl1WTJ4aGMzTk1hWE4wTG5SdloyZHNaU2hjSW1ocFpHUmxibHdpS1R0Y2NseHVmVHRjY2x4dVhISmNibkpsWVdSTVpYTnpNaTV2Ym1Oc2FXTnJJRDBnS0NrZ1BUNGdlMXh5WEc0Z0lIUmxlSFJUWldOdmJtUXVZMnhoYzNOTWFYTjBMblJ2WjJkc1pTaGNJbTF2Y21WY0lpazdYSEpjYmlBZ2NtVmhaRTF2Y21VeUxtTnNZWE56VEdsemRDNTBiMmRuYkdVb1hDSm9hV1JrWlc1Y0lpazdYSEpjYmlBZ2NtVmhaRXhsYzNNeUxtTnNZWE56VEdsemRDNTBiMmRuYkdVb1hDSm9hV1JrWlc1Y0lpazdYSEpjYm4wN1hISmNibHh5WEc1amIyNXpkQ0J5Wlc1a1pYSlFjbTlrZFdOMGN5QTlJR2wwWlcwZ1BUNGdlMXh5WEc0Z0lISmxkSFZ5YmlCZ1BHUnBkaUJqYkdGemN6MWNJbU52YkMweE1pQmpiMnd0YldRdE5pQmpiMnd0YkdjdE5Gd2lQbHh5WEc0Z0lEeGthWFlnWTJ4aGMzTTlYQ0p3Y205cVpXTjBjMTlmWTJGeVpGd2lQbHh5WEc0Z0lDQWdQR1JwZGlCamJHRnpjejFjSW5CeWIycGxZM1J6WDE5cGJXY3RkM0poY0hCbGNsd2lQanhwYldjZ2MzSmpQVndpSkh0cGRHVnRMbk55WTMxY0lpQmhiSFE5WENKdFlYTnJYQ0krUEM5a2FYWStYSEpjYmlBZ0lDQThaR2wySUdOc1lYTnpQVndpY0hKdmFtVmpkSE5mWDJsdVptOWNJajVjY2x4dUlDQWdJQ0FnUEdnMElHTnNZWE56UFZ3aWNISnZhbVZqZEhOZlgzTjFZblJwZEd4bFhDSStKSHRwZEdWdExuTjFZblJwZEd4bGZUd3ZhRFErWEhKY2JpQWdJQ0FnSUR4d0lHTnNZWE56UFZ3aWNISnZhbVZqZEhOZlgzUmxlSFJjSWo0a2UybDBaVzB1ZEdWNGRIMDhMM0ErWEhKY2JpQWdJQ0E4TDJScGRqNWNjbHh1SUNBOEwyUnBkajVjY2x4dVBDOWthWFkrWUR0Y2NseHVmVHRjY2x4dVhISmNibXhsZENCeVpXNWtaWEpUWldOMGFXOXVJRDBnY0hKdmFtVmpkSE5FWVhSaElEMCtJSHRjY2x4dUlDQmpiMjV6ZENCd2NtOXFaV04wY3lBOUlIQnliMnBsWTNSelJHRjBZUzV0WVhBb1pXeGxiV1Z1ZENBOVBpQnlaVzVrWlhKUWNtOWtkV04wY3lobGJHVnRaVzUwS1NrN1hISmNiaUFnWkc5amRXMWxiblF1WjJWMFJXeGxiV1Z1ZEVKNVNXUW9YQ0p3Y205cVpXTjBjMUpsYm1SbGNsd2lLUzVwYm01bGNraFVUVXdnUFNCd2NtOXFaV04wY3k1cWIybHVLRndpWENJcE8xeHlYRzU5TzF4eVhHNWNjbHh1YzJWbFRXOXlaUzV2Ym1Oc2FXTnJJRDBnWlNBOVBpQjdYSEpjYmlBZ1pTNXdjbVYyWlc1MFJHVm1ZWFZzZENncE8xeHlYRzRnSUdOdmRXNTBaWElnS3owZ2NtRnBjMlZ5TzF4eVhHNGdJSEpsYm1SbGNsTmxZM1JwYjI0b2NISnZaSFZqZEhNdWMyeHBZMlVvTUN3Z1kyOTFiblJsY2lrcE8xeHlYRzU5TzF4eVhHNWNjbHh1ZDJsdVpHOTNMbUZrWkVWMlpXNTBUR2x6ZEdWdVpYSW9YQ0pFVDAxRGIyNTBaVzUwVEc5aFpHVmtYQ0lzSUNncElEMCtJSHRjY2x4dUlDQmpiMjV6ZENCM2FYUmthRU52ZFc1MFpYSWdQU0JoYzNsdVl5QW9LU0E5UGlCN1hISmNiaUFnSUNCemQybDBZMmdnS0hSeWRXVXBJSHRjY2x4dUlDQWdJQ0FnWTJGelpTQmtiMk4xYldWdWRDNWtiMk4xYldWdWRFVnNaVzFsYm5RdVkyeHBaVzUwVjJsa2RHZ2dQaUEzTmpnNlhISmNiaUFnSUNBZ0lDQWdZMjkxYm5SbGNpQTlJRGs3WEhKY2JpQWdJQ0FnSUNBZ1luSmxZV3M3WEhKY2JpQWdJQ0FnSUdOaGMyVWdaRzlqZFcxbGJuUXVaRzlqZFcxbGJuUkZiR1Z0Wlc1MExtTnNhV1Z1ZEZkcFpIUm9JRDRnTkRFME9seHlYRzRnSUNBZ0lDQWdJR052ZFc1MFpYSWdQU0EwTzF4eVhHNGdJQ0FnSUNBZ0lISmhhWE5sY2lBOUlEUTdYSEpjYmlBZ0lDQWdJQ0FnWW5KbFlXczdYSEpjYmlBZ0lDQWdJR1JsWm1GMWJIUTZYSEpjYmlBZ0lDQWdJQ0FnWTI5MWJuUmxjaUE5SURNN1hISmNiaUFnSUNBZ0lDQWdjbUZwYzJWeUlEMGdNenRjY2x4dUlDQWdJQ0FnSUNCaWNtVmhhenRjY2x4dUlDQWdJSDFjY2x4dUlDQjlPMXh5WEc0Z0lIZHBkR1JvUTI5MWJuUmxjaWdwTzF4eVhHNGdJSEpsYm1SbGNsTmxZM1JwYjI0b2NISnZaSFZqZEhNdWMyeHBZMlVvTUN3Z1kyOTFiblJsY2lrcE8xeHlYRzU5S1R0Y2NseHVJbDE5In0=
