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
var listFirst = document.getElementById("listFirst");
var textFirst = document.getElementById("textFirst");
var textSecond = document.getElementById("textSecond");
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

readMore1.onclick = function (e) {
  e.preventDefault();
  listFirst.classList.add("more");
  textFirst.classList.add("more");
};

readMore2.onclick = function (e) {
  e.preventDefault();
  textSecond.classList.add("more");
};

var renderProducts = function renderProducts(item) {
  return "<div class=\"col-12 col-md-6 col-lg-4\">\n  <div class=\"projects__card\">\n    <img src=\"".concat(item.src, "\" alt=\"mask\">\n    <div class=\"projects__info\">\n      <h4 class=\"projects__subtitle\">").concat(item.subtitle, "</h4>\n      <p class=\"projects__text\">").concat(item.text, "</p>\n    </div>\n  </div>\n</div>");
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

//# sourceMappingURL=data:application/json;charset=utf8;base64,eyJ2ZXJzaW9uIjozLCJzb3VyY2VzIjpbIm5vZGVfbW9kdWxlcy9icm93c2VyLXBhY2svX3ByZWx1ZGUuanMiLCJub2RlX21vZHVsZXMvcmVnZW5lcmF0b3ItcnVudGltZS9ydW50aW1lLmpzIiwicHJvamVjdHMvd2hpdGVwb3J0LXNpdGUvc3JjL2pzL2FwcC5qcyJdLCJuYW1lcyI6W10sIm1hcHBpbmdzIjoiQUFBQTtBQ0FBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBOzs7Ozs7Ozs7Ozs7QUN0dEJBLElBQU0sa0JBQWtCLEdBQUcsT0FBTyxDQUFDLHFCQUFELENBQWxDOztBQUVBLElBQU0sT0FBTyxHQUFHLFFBQVEsQ0FBQyxhQUFULENBQXVCLE9BQXZCLENBQWhCO0FBQ0EsSUFBTSxVQUFVLEdBQUcsUUFBUSxDQUFDLGNBQVQsQ0FBd0IsWUFBeEIsQ0FBbkI7QUFDQSxJQUFNLFFBQVEsR0FBRyxRQUFRLENBQUMsY0FBVCxDQUF3QixVQUF4QixDQUFqQjtBQUNBLElBQU0sTUFBTSxHQUFHLFFBQVEsQ0FBQyxjQUFULENBQXdCLFFBQXhCLENBQWY7QUFDQSxJQUFNLFVBQVUsR0FBRyxRQUFRLENBQUMsY0FBVCxDQUF3QixZQUF4QixDQUFuQjtBQUNBLElBQU0sT0FBTyxHQUFHLFFBQVEsQ0FBQyxjQUFULENBQXdCLFNBQXhCLENBQWhCO0FBQ0EsSUFBTSxTQUFTLEdBQUcsUUFBUSxDQUFDLGNBQVQsQ0FBd0IsV0FBeEIsQ0FBbEI7QUFDQSxJQUFNLFNBQVMsR0FBRyxRQUFRLENBQUMsY0FBVCxDQUF3QixXQUF4QixDQUFsQjtBQUNBLElBQU0sU0FBUyxHQUFHLFFBQVEsQ0FBQyxjQUFULENBQXdCLFdBQXhCLENBQWxCO0FBQ0EsSUFBTSxTQUFTLEdBQUcsUUFBUSxDQUFDLGNBQVQsQ0FBd0IsV0FBeEIsQ0FBbEI7QUFDQSxJQUFNLFVBQVUsR0FBRyxRQUFRLENBQUMsY0FBVCxDQUF3QixZQUF4QixDQUFuQjtBQUNBLElBQUksT0FBTyxHQUFHLENBQWQ7QUFDQSxJQUFJLE1BQU0sR0FBRyxDQUFiO0FBQ0EsSUFBTSxRQUFRLEdBQUcsQ0FDZjtBQUNFLEVBQUEsR0FBRyxFQUFFLG1CQURQO0FBRUUsRUFBQSxRQUFRLEVBQUUsd0JBRlo7QUFHRSxFQUFBLElBQUksRUFDRjtBQUpKLENBRGUsRUFPZjtBQUNFLEVBQUEsR0FBRyxFQUFFLG1CQURQO0FBRUUsRUFBQSxRQUFRLEVBQUUsbUJBRlo7QUFHRSxFQUFBLElBQUksRUFDRjtBQUpKLENBUGUsRUFhZjtBQUNFLEVBQUEsR0FBRyxFQUFFLHFCQURQO0FBRUUsRUFBQSxRQUFRLEVBQUUsVUFGWjtBQUdFLEVBQUEsSUFBSSxFQUNGO0FBSkosQ0FiZSxFQW1CZjtBQUNFLEVBQUEsR0FBRyxFQUFFLDBCQURQO0FBRUUsRUFBQSxRQUFRLEVBQUUsZUFGWjtBQUdFLEVBQUEsSUFBSSxFQUNGO0FBSkosQ0FuQmUsRUF5QmY7QUFDRSxFQUFBLEdBQUcsRUFBRSxvQkFEUDtBQUVFLEVBQUEsUUFBUSxFQUFFLFNBRlo7QUFHRSxFQUFBLElBQUksRUFDRjtBQUpKLENBekJlLEVBK0JmO0FBQ0UsRUFBQSxHQUFHLEVBQUUsbUJBRFA7QUFFRSxFQUFBLFFBQVEsRUFBRSxRQUZaO0FBR0UsRUFBQSxJQUFJLEVBQ0Y7QUFKSixDQS9CZSxFQXFDZjtBQUNFLEVBQUEsR0FBRyxFQUFFLHFCQURQO0FBRUUsRUFBQSxRQUFRLEVBQUUsVUFGWjtBQUdFLEVBQUEsSUFBSSxFQUNGO0FBSkosQ0FyQ2UsRUEyQ2Y7QUFDRSxFQUFBLEdBQUcsRUFBRSxrQ0FEUDtBQUVFLEVBQUEsUUFBUSxFQUFFLHVCQUZaO0FBR0UsRUFBQSxJQUFJLEVBQ0Y7QUFKSixDQTNDZSxFQWlEZjtBQUNFLEVBQUEsR0FBRyxFQUFFLDRCQURQO0FBRUUsRUFBQSxRQUFRLEVBQUUsaUJBRlo7QUFHRSxFQUFBLElBQUksRUFDRjtBQUpKLENBakRlLENBQWpCO0FBeURBLFFBQVEsQ0FBQyxnQkFBVCxDQUEwQixRQUExQixFQUFvQyxZQUFNO0FBQ3hDLE1BQUksTUFBTSxDQUFDLFdBQVAsR0FBcUIsT0FBTyxDQUFDLFlBQWpDLEVBQStDO0FBQzdDLElBQUEsT0FBTyxDQUFDLFNBQVIsQ0FBa0IsTUFBbEIsQ0FBeUIsT0FBekI7QUFDRCxHQUZELE1BRU87QUFDTCxJQUFBLE9BQU8sQ0FBQyxTQUFSLENBQWtCLEdBQWxCLENBQXNCLE9BQXRCO0FBQ0Q7QUFDRixDQU5EOztBQVFBLE1BQU0sQ0FBQyxPQUFQLEdBQWlCLFVBQUEsQ0FBQyxFQUFJO0FBQ3BCLEVBQUEsQ0FBQyxDQUFDLGNBQUY7QUFDQSxFQUFBLFVBQVUsQ0FBQyxTQUFYLENBQXFCLE1BQXJCLENBQTRCLE1BQTVCO0FBQ0QsQ0FIRDs7QUFLQSxRQUFRLENBQUMsT0FBVCxHQUFtQixVQUFBLENBQUMsRUFBSTtBQUN0QixFQUFBLENBQUMsQ0FBQyxjQUFGO0FBQ0EsRUFBQSxVQUFVLENBQUMsU0FBWCxDQUFxQixNQUFyQixDQUE0QixNQUE1QjtBQUNELENBSEQ7O0FBS0EsVUFBVSxDQUFDLE9BQVgsR0FBcUIsWUFBTTtBQUN6QixFQUFBLFVBQVUsQ0FBQyxTQUFYLENBQXFCLE1BQXJCLENBQTRCLE1BQTVCO0FBQ0QsQ0FGRDs7QUFJQSxTQUFTLENBQUMsZ0JBQVYsQ0FBMkIsT0FBM0IsRUFBb0MsVUFBQSxDQUFDLEVBQUk7QUFDdkMsTUFBSSxNQUFNLEdBQUcsQ0FBQyxDQUFDLE1BQWY7QUFDQSxNQUFNLElBQUksR0FBRyxRQUFRLENBQUMsc0JBQVQsQ0FBZ0Msd0JBQWhDLENBQWI7O0FBQ0EsTUFBSSxHQUFHLHNCQUFPLElBQVAsQ0FBUDs7QUFDQSxNQUFJLE1BQU0sQ0FBQyxTQUFQLENBQWlCLFFBQWpCLENBQTBCLE1BQTFCLENBQUosRUFBdUM7QUFDckMsSUFBQSxNQUFNLENBQUMsU0FBUCxDQUFpQixNQUFqQixDQUF3QixNQUF4QjtBQUNELEdBRkQsTUFFTztBQUNMLElBQUEsR0FBRyxDQUFDLEdBQUosQ0FBUSxVQUFBLENBQUM7QUFBQSxhQUFJLENBQUMsQ0FBQyxTQUFGLENBQVksTUFBWixDQUFtQixNQUFuQixDQUFKO0FBQUEsS0FBVDtBQUNBLElBQUEsTUFBTSxDQUFDLFNBQVAsQ0FBaUIsTUFBakIsQ0FBd0IsTUFBeEI7QUFDRDtBQUNGLENBVkQ7O0FBWUEsU0FBUyxDQUFDLE9BQVYsR0FBb0IsVUFBQSxDQUFDLEVBQUk7QUFDdkIsRUFBQSxDQUFDLENBQUMsY0FBRjtBQUNBLEVBQUEsU0FBUyxDQUFDLFNBQVYsQ0FBb0IsR0FBcEIsQ0FBd0IsTUFBeEI7QUFDQSxFQUFBLFNBQVMsQ0FBQyxTQUFWLENBQW9CLEdBQXBCLENBQXdCLE1BQXhCO0FBQ0QsQ0FKRDs7QUFNQSxTQUFTLENBQUMsT0FBVixHQUFvQixVQUFBLENBQUMsRUFBSTtBQUN2QixFQUFBLENBQUMsQ0FBQyxjQUFGO0FBQ0EsRUFBQSxVQUFVLENBQUMsU0FBWCxDQUFxQixHQUFyQixDQUF5QixNQUF6QjtBQUNELENBSEQ7O0FBS0EsSUFBTSxjQUFjLEdBQUcsU0FBakIsY0FBaUIsQ0FBQSxJQUFJLEVBQUk7QUFDN0IsOEdBRWMsSUFBSSxDQUFDLEdBRm5CLDBHQUlxQyxJQUFJLENBQUMsUUFKMUMsc0RBS2dDLElBQUksQ0FBQyxJQUxyQztBQVNELENBVkQ7O0FBWUEsSUFBSSxhQUFhLEdBQUcsU0FBaEIsYUFBZ0IsQ0FBQSxZQUFZLEVBQUk7QUFDbEMsTUFBTSxRQUFRLEdBQUcsWUFBWSxDQUFDLEdBQWIsQ0FBaUIsVUFBQSxPQUFPO0FBQUEsV0FBSSxjQUFjLENBQUMsT0FBRCxDQUFsQjtBQUFBLEdBQXhCLENBQWpCO0FBQ0EsRUFBQSxRQUFRLENBQUMsY0FBVCxDQUF3QixnQkFBeEIsRUFBMEMsU0FBMUMsR0FBc0QsUUFBUSxDQUFDLElBQVQsQ0FBYyxFQUFkLENBQXREO0FBQ0QsQ0FIRDs7QUFLQSxPQUFPLENBQUMsT0FBUixHQUFrQixVQUFBLENBQUMsRUFBSTtBQUNyQixFQUFBLENBQUMsQ0FBQyxjQUFGO0FBQ0EsRUFBQSxPQUFPLElBQUksTUFBWDtBQUNBLEVBQUEsYUFBYSxDQUFDLFFBQVEsQ0FBQyxLQUFULENBQWUsQ0FBZixFQUFrQixPQUFsQixDQUFELENBQWI7QUFDRCxDQUpEOztBQU1BLE1BQU0sQ0FBQyxnQkFBUCxDQUF3QixrQkFBeEIsRUFBNEMsWUFBTTtBQUNoRCxNQUFNLFlBQVksR0FBRyxTQUFmLFlBQWU7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBLDBCQUNYLElBRFc7QUFBQSw0Q0FFWixRQUFRLENBQUMsZUFBVCxDQUF5QixXQUF6QixHQUF1QyxHQUYzQix1QkFLWixRQUFRLENBQUMsZUFBVCxDQUF5QixXQUF6QixHQUF1QyxHQUwzQjtBQUFBOztBQUFBO0FBR2YsWUFBQSxPQUFPLEdBQUcsQ0FBVjtBQUhlOztBQUFBO0FBTWYsWUFBQSxPQUFPLEdBQUcsQ0FBVjtBQUNBLFlBQUEsTUFBTSxHQUFHLENBQVQ7QUFQZTs7QUFBQTtBQVVmLFlBQUEsT0FBTyxHQUFHLENBQVY7QUFDQSxZQUFBLE1BQU0sR0FBRyxDQUFUO0FBWGU7O0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUEsR0FBckI7O0FBZUEsRUFBQSxZQUFZO0FBQ1osRUFBQSxhQUFhLENBQUMsUUFBUSxDQUFDLEtBQVQsQ0FBZSxDQUFmLEVBQWtCLE9BQWxCLENBQUQsQ0FBYjtBQUNELENBbEJEIiwiZmlsZSI6ImJ1bmRsZS5qcyIsInNvdXJjZXNDb250ZW50IjpbIihmdW5jdGlvbigpe2Z1bmN0aW9uIHIoZSxuLHQpe2Z1bmN0aW9uIG8oaSxmKXtpZighbltpXSl7aWYoIWVbaV0pe3ZhciBjPVwiZnVuY3Rpb25cIj09dHlwZW9mIHJlcXVpcmUmJnJlcXVpcmU7aWYoIWYmJmMpcmV0dXJuIGMoaSwhMCk7aWYodSlyZXR1cm4gdShpLCEwKTt2YXIgYT1uZXcgRXJyb3IoXCJDYW5ub3QgZmluZCBtb2R1bGUgJ1wiK2krXCInXCIpO3Rocm93IGEuY29kZT1cIk1PRFVMRV9OT1RfRk9VTkRcIixhfXZhciBwPW5baV09e2V4cG9ydHM6e319O2VbaV1bMF0uY2FsbChwLmV4cG9ydHMsZnVuY3Rpb24ocil7dmFyIG49ZVtpXVsxXVtyXTtyZXR1cm4gbyhufHxyKX0scCxwLmV4cG9ydHMscixlLG4sdCl9cmV0dXJuIG5baV0uZXhwb3J0c31mb3IodmFyIHU9XCJmdW5jdGlvblwiPT10eXBlb2YgcmVxdWlyZSYmcmVxdWlyZSxpPTA7aTx0Lmxlbmd0aDtpKyspbyh0W2ldKTtyZXR1cm4gb31yZXR1cm4gcn0pKCkiLCIvKipcbiAqIENvcHlyaWdodCAoYykgMjAxNC1wcmVzZW50LCBGYWNlYm9vaywgSW5jLlxuICpcbiAqIFRoaXMgc291cmNlIGNvZGUgaXMgbGljZW5zZWQgdW5kZXIgdGhlIE1JVCBsaWNlbnNlIGZvdW5kIGluIHRoZVxuICogTElDRU5TRSBmaWxlIGluIHRoZSByb290IGRpcmVjdG9yeSBvZiB0aGlzIHNvdXJjZSB0cmVlLlxuICovXG5cbnZhciBydW50aW1lID0gKGZ1bmN0aW9uIChleHBvcnRzKSB7XG4gIFwidXNlIHN0cmljdFwiO1xuXG4gIHZhciBPcCA9IE9iamVjdC5wcm90b3R5cGU7XG4gIHZhciBoYXNPd24gPSBPcC5oYXNPd25Qcm9wZXJ0eTtcbiAgdmFyIHVuZGVmaW5lZDsgLy8gTW9yZSBjb21wcmVzc2libGUgdGhhbiB2b2lkIDAuXG4gIHZhciAkU3ltYm9sID0gdHlwZW9mIFN5bWJvbCA9PT0gXCJmdW5jdGlvblwiID8gU3ltYm9sIDoge307XG4gIHZhciBpdGVyYXRvclN5bWJvbCA9ICRTeW1ib2wuaXRlcmF0b3IgfHwgXCJAQGl0ZXJhdG9yXCI7XG4gIHZhciBhc3luY0l0ZXJhdG9yU3ltYm9sID0gJFN5bWJvbC5hc3luY0l0ZXJhdG9yIHx8IFwiQEBhc3luY0l0ZXJhdG9yXCI7XG4gIHZhciB0b1N0cmluZ1RhZ1N5bWJvbCA9ICRTeW1ib2wudG9TdHJpbmdUYWcgfHwgXCJAQHRvU3RyaW5nVGFnXCI7XG5cbiAgZnVuY3Rpb24gd3JhcChpbm5lckZuLCBvdXRlckZuLCBzZWxmLCB0cnlMb2NzTGlzdCkge1xuICAgIC8vIElmIG91dGVyRm4gcHJvdmlkZWQgYW5kIG91dGVyRm4ucHJvdG90eXBlIGlzIGEgR2VuZXJhdG9yLCB0aGVuIG91dGVyRm4ucHJvdG90eXBlIGluc3RhbmNlb2YgR2VuZXJhdG9yLlxuICAgIHZhciBwcm90b0dlbmVyYXRvciA9IG91dGVyRm4gJiYgb3V0ZXJGbi5wcm90b3R5cGUgaW5zdGFuY2VvZiBHZW5lcmF0b3IgPyBvdXRlckZuIDogR2VuZXJhdG9yO1xuICAgIHZhciBnZW5lcmF0b3IgPSBPYmplY3QuY3JlYXRlKHByb3RvR2VuZXJhdG9yLnByb3RvdHlwZSk7XG4gICAgdmFyIGNvbnRleHQgPSBuZXcgQ29udGV4dCh0cnlMb2NzTGlzdCB8fCBbXSk7XG5cbiAgICAvLyBUaGUgLl9pbnZva2UgbWV0aG9kIHVuaWZpZXMgdGhlIGltcGxlbWVudGF0aW9ucyBvZiB0aGUgLm5leHQsXG4gICAgLy8gLnRocm93LCBhbmQgLnJldHVybiBtZXRob2RzLlxuICAgIGdlbmVyYXRvci5faW52b2tlID0gbWFrZUludm9rZU1ldGhvZChpbm5lckZuLCBzZWxmLCBjb250ZXh0KTtcblxuICAgIHJldHVybiBnZW5lcmF0b3I7XG4gIH1cbiAgZXhwb3J0cy53cmFwID0gd3JhcDtcblxuICAvLyBUcnkvY2F0Y2ggaGVscGVyIHRvIG1pbmltaXplIGRlb3B0aW1pemF0aW9ucy4gUmV0dXJucyBhIGNvbXBsZXRpb25cbiAgLy8gcmVjb3JkIGxpa2UgY29udGV4dC50cnlFbnRyaWVzW2ldLmNvbXBsZXRpb24uIFRoaXMgaW50ZXJmYWNlIGNvdWxkXG4gIC8vIGhhdmUgYmVlbiAoYW5kIHdhcyBwcmV2aW91c2x5KSBkZXNpZ25lZCB0byB0YWtlIGEgY2xvc3VyZSB0byBiZVxuICAvLyBpbnZva2VkIHdpdGhvdXQgYXJndW1lbnRzLCBidXQgaW4gYWxsIHRoZSBjYXNlcyB3ZSBjYXJlIGFib3V0IHdlXG4gIC8vIGFscmVhZHkgaGF2ZSBhbiBleGlzdGluZyBtZXRob2Qgd2Ugd2FudCB0byBjYWxsLCBzbyB0aGVyZSdzIG5vIG5lZWRcbiAgLy8gdG8gY3JlYXRlIGEgbmV3IGZ1bmN0aW9uIG9iamVjdC4gV2UgY2FuIGV2ZW4gZ2V0IGF3YXkgd2l0aCBhc3N1bWluZ1xuICAvLyB0aGUgbWV0aG9kIHRha2VzIGV4YWN0bHkgb25lIGFyZ3VtZW50LCBzaW5jZSB0aGF0IGhhcHBlbnMgdG8gYmUgdHJ1ZVxuICAvLyBpbiBldmVyeSBjYXNlLCBzbyB3ZSBkb24ndCBoYXZlIHRvIHRvdWNoIHRoZSBhcmd1bWVudHMgb2JqZWN0LiBUaGVcbiAgLy8gb25seSBhZGRpdGlvbmFsIGFsbG9jYXRpb24gcmVxdWlyZWQgaXMgdGhlIGNvbXBsZXRpb24gcmVjb3JkLCB3aGljaFxuICAvLyBoYXMgYSBzdGFibGUgc2hhcGUgYW5kIHNvIGhvcGVmdWxseSBzaG91bGQgYmUgY2hlYXAgdG8gYWxsb2NhdGUuXG4gIGZ1bmN0aW9uIHRyeUNhdGNoKGZuLCBvYmosIGFyZykge1xuICAgIHRyeSB7XG4gICAgICByZXR1cm4geyB0eXBlOiBcIm5vcm1hbFwiLCBhcmc6IGZuLmNhbGwob2JqLCBhcmcpIH07XG4gICAgfSBjYXRjaCAoZXJyKSB7XG4gICAgICByZXR1cm4geyB0eXBlOiBcInRocm93XCIsIGFyZzogZXJyIH07XG4gICAgfVxuICB9XG5cbiAgdmFyIEdlblN0YXRlU3VzcGVuZGVkU3RhcnQgPSBcInN1c3BlbmRlZFN0YXJ0XCI7XG4gIHZhciBHZW5TdGF0ZVN1c3BlbmRlZFlpZWxkID0gXCJzdXNwZW5kZWRZaWVsZFwiO1xuICB2YXIgR2VuU3RhdGVFeGVjdXRpbmcgPSBcImV4ZWN1dGluZ1wiO1xuICB2YXIgR2VuU3RhdGVDb21wbGV0ZWQgPSBcImNvbXBsZXRlZFwiO1xuXG4gIC8vIFJldHVybmluZyB0aGlzIG9iamVjdCBmcm9tIHRoZSBpbm5lckZuIGhhcyB0aGUgc2FtZSBlZmZlY3QgYXNcbiAgLy8gYnJlYWtpbmcgb3V0IG9mIHRoZSBkaXNwYXRjaCBzd2l0Y2ggc3RhdGVtZW50LlxuICB2YXIgQ29udGludWVTZW50aW5lbCA9IHt9O1xuXG4gIC8vIER1bW15IGNvbnN0cnVjdG9yIGZ1bmN0aW9ucyB0aGF0IHdlIHVzZSBhcyB0aGUgLmNvbnN0cnVjdG9yIGFuZFxuICAvLyAuY29uc3RydWN0b3IucHJvdG90eXBlIHByb3BlcnRpZXMgZm9yIGZ1bmN0aW9ucyB0aGF0IHJldHVybiBHZW5lcmF0b3JcbiAgLy8gb2JqZWN0cy4gRm9yIGZ1bGwgc3BlYyBjb21wbGlhbmNlLCB5b3UgbWF5IHdpc2ggdG8gY29uZmlndXJlIHlvdXJcbiAgLy8gbWluaWZpZXIgbm90IHRvIG1hbmdsZSB0aGUgbmFtZXMgb2YgdGhlc2UgdHdvIGZ1bmN0aW9ucy5cbiAgZnVuY3Rpb24gR2VuZXJhdG9yKCkge31cbiAgZnVuY3Rpb24gR2VuZXJhdG9yRnVuY3Rpb24oKSB7fVxuICBmdW5jdGlvbiBHZW5lcmF0b3JGdW5jdGlvblByb3RvdHlwZSgpIHt9XG5cbiAgLy8gVGhpcyBpcyBhIHBvbHlmaWxsIGZvciAlSXRlcmF0b3JQcm90b3R5cGUlIGZvciBlbnZpcm9ubWVudHMgdGhhdFxuICAvLyBkb24ndCBuYXRpdmVseSBzdXBwb3J0IGl0LlxuICB2YXIgSXRlcmF0b3JQcm90b3R5cGUgPSB7fTtcbiAgSXRlcmF0b3JQcm90b3R5cGVbaXRlcmF0b3JTeW1ib2xdID0gZnVuY3Rpb24gKCkge1xuICAgIHJldHVybiB0aGlzO1xuICB9O1xuXG4gIHZhciBnZXRQcm90byA9IE9iamVjdC5nZXRQcm90b3R5cGVPZjtcbiAgdmFyIE5hdGl2ZUl0ZXJhdG9yUHJvdG90eXBlID0gZ2V0UHJvdG8gJiYgZ2V0UHJvdG8oZ2V0UHJvdG8odmFsdWVzKFtdKSkpO1xuICBpZiAoTmF0aXZlSXRlcmF0b3JQcm90b3R5cGUgJiZcbiAgICAgIE5hdGl2ZUl0ZXJhdG9yUHJvdG90eXBlICE9PSBPcCAmJlxuICAgICAgaGFzT3duLmNhbGwoTmF0aXZlSXRlcmF0b3JQcm90b3R5cGUsIGl0ZXJhdG9yU3ltYm9sKSkge1xuICAgIC8vIFRoaXMgZW52aXJvbm1lbnQgaGFzIGEgbmF0aXZlICVJdGVyYXRvclByb3RvdHlwZSU7IHVzZSBpdCBpbnN0ZWFkXG4gICAgLy8gb2YgdGhlIHBvbHlmaWxsLlxuICAgIEl0ZXJhdG9yUHJvdG90eXBlID0gTmF0aXZlSXRlcmF0b3JQcm90b3R5cGU7XG4gIH1cblxuICB2YXIgR3AgPSBHZW5lcmF0b3JGdW5jdGlvblByb3RvdHlwZS5wcm90b3R5cGUgPVxuICAgIEdlbmVyYXRvci5wcm90b3R5cGUgPSBPYmplY3QuY3JlYXRlKEl0ZXJhdG9yUHJvdG90eXBlKTtcbiAgR2VuZXJhdG9yRnVuY3Rpb24ucHJvdG90eXBlID0gR3AuY29uc3RydWN0b3IgPSBHZW5lcmF0b3JGdW5jdGlvblByb3RvdHlwZTtcbiAgR2VuZXJhdG9yRnVuY3Rpb25Qcm90b3R5cGUuY29uc3RydWN0b3IgPSBHZW5lcmF0b3JGdW5jdGlvbjtcbiAgR2VuZXJhdG9yRnVuY3Rpb25Qcm90b3R5cGVbdG9TdHJpbmdUYWdTeW1ib2xdID1cbiAgICBHZW5lcmF0b3JGdW5jdGlvbi5kaXNwbGF5TmFtZSA9IFwiR2VuZXJhdG9yRnVuY3Rpb25cIjtcblxuICAvLyBIZWxwZXIgZm9yIGRlZmluaW5nIHRoZSAubmV4dCwgLnRocm93LCBhbmQgLnJldHVybiBtZXRob2RzIG9mIHRoZVxuICAvLyBJdGVyYXRvciBpbnRlcmZhY2UgaW4gdGVybXMgb2YgYSBzaW5nbGUgLl9pbnZva2UgbWV0aG9kLlxuICBmdW5jdGlvbiBkZWZpbmVJdGVyYXRvck1ldGhvZHMocHJvdG90eXBlKSB7XG4gICAgW1wibmV4dFwiLCBcInRocm93XCIsIFwicmV0dXJuXCJdLmZvckVhY2goZnVuY3Rpb24obWV0aG9kKSB7XG4gICAgICBwcm90b3R5cGVbbWV0aG9kXSA9IGZ1bmN0aW9uKGFyZykge1xuICAgICAgICByZXR1cm4gdGhpcy5faW52b2tlKG1ldGhvZCwgYXJnKTtcbiAgICAgIH07XG4gICAgfSk7XG4gIH1cblxuICBleHBvcnRzLmlzR2VuZXJhdG9yRnVuY3Rpb24gPSBmdW5jdGlvbihnZW5GdW4pIHtcbiAgICB2YXIgY3RvciA9IHR5cGVvZiBnZW5GdW4gPT09IFwiZnVuY3Rpb25cIiAmJiBnZW5GdW4uY29uc3RydWN0b3I7XG4gICAgcmV0dXJuIGN0b3JcbiAgICAgID8gY3RvciA9PT0gR2VuZXJhdG9yRnVuY3Rpb24gfHxcbiAgICAgICAgLy8gRm9yIHRoZSBuYXRpdmUgR2VuZXJhdG9yRnVuY3Rpb24gY29uc3RydWN0b3IsIHRoZSBiZXN0IHdlIGNhblxuICAgICAgICAvLyBkbyBpcyB0byBjaGVjayBpdHMgLm5hbWUgcHJvcGVydHkuXG4gICAgICAgIChjdG9yLmRpc3BsYXlOYW1lIHx8IGN0b3IubmFtZSkgPT09IFwiR2VuZXJhdG9yRnVuY3Rpb25cIlxuICAgICAgOiBmYWxzZTtcbiAgfTtcblxuICBleHBvcnRzLm1hcmsgPSBmdW5jdGlvbihnZW5GdW4pIHtcbiAgICBpZiAoT2JqZWN0LnNldFByb3RvdHlwZU9mKSB7XG4gICAgICBPYmplY3Quc2V0UHJvdG90eXBlT2YoZ2VuRnVuLCBHZW5lcmF0b3JGdW5jdGlvblByb3RvdHlwZSk7XG4gICAgfSBlbHNlIHtcbiAgICAgIGdlbkZ1bi5fX3Byb3RvX18gPSBHZW5lcmF0b3JGdW5jdGlvblByb3RvdHlwZTtcbiAgICAgIGlmICghKHRvU3RyaW5nVGFnU3ltYm9sIGluIGdlbkZ1bikpIHtcbiAgICAgICAgZ2VuRnVuW3RvU3RyaW5nVGFnU3ltYm9sXSA9IFwiR2VuZXJhdG9yRnVuY3Rpb25cIjtcbiAgICAgIH1cbiAgICB9XG4gICAgZ2VuRnVuLnByb3RvdHlwZSA9IE9iamVjdC5jcmVhdGUoR3ApO1xuICAgIHJldHVybiBnZW5GdW47XG4gIH07XG5cbiAgLy8gV2l0aGluIHRoZSBib2R5IG9mIGFueSBhc3luYyBmdW5jdGlvbiwgYGF3YWl0IHhgIGlzIHRyYW5zZm9ybWVkIHRvXG4gIC8vIGB5aWVsZCByZWdlbmVyYXRvclJ1bnRpbWUuYXdyYXAoeClgLCBzbyB0aGF0IHRoZSBydW50aW1lIGNhbiB0ZXN0XG4gIC8vIGBoYXNPd24uY2FsbCh2YWx1ZSwgXCJfX2F3YWl0XCIpYCB0byBkZXRlcm1pbmUgaWYgdGhlIHlpZWxkZWQgdmFsdWUgaXNcbiAgLy8gbWVhbnQgdG8gYmUgYXdhaXRlZC5cbiAgZXhwb3J0cy5hd3JhcCA9IGZ1bmN0aW9uKGFyZykge1xuICAgIHJldHVybiB7IF9fYXdhaXQ6IGFyZyB9O1xuICB9O1xuXG4gIGZ1bmN0aW9uIEFzeW5jSXRlcmF0b3IoZ2VuZXJhdG9yKSB7XG4gICAgZnVuY3Rpb24gaW52b2tlKG1ldGhvZCwgYXJnLCByZXNvbHZlLCByZWplY3QpIHtcbiAgICAgIHZhciByZWNvcmQgPSB0cnlDYXRjaChnZW5lcmF0b3JbbWV0aG9kXSwgZ2VuZXJhdG9yLCBhcmcpO1xuICAgICAgaWYgKHJlY29yZC50eXBlID09PSBcInRocm93XCIpIHtcbiAgICAgICAgcmVqZWN0KHJlY29yZC5hcmcpO1xuICAgICAgfSBlbHNlIHtcbiAgICAgICAgdmFyIHJlc3VsdCA9IHJlY29yZC5hcmc7XG4gICAgICAgIHZhciB2YWx1ZSA9IHJlc3VsdC52YWx1ZTtcbiAgICAgICAgaWYgKHZhbHVlICYmXG4gICAgICAgICAgICB0eXBlb2YgdmFsdWUgPT09IFwib2JqZWN0XCIgJiZcbiAgICAgICAgICAgIGhhc093bi5jYWxsKHZhbHVlLCBcIl9fYXdhaXRcIikpIHtcbiAgICAgICAgICByZXR1cm4gUHJvbWlzZS5yZXNvbHZlKHZhbHVlLl9fYXdhaXQpLnRoZW4oZnVuY3Rpb24odmFsdWUpIHtcbiAgICAgICAgICAgIGludm9rZShcIm5leHRcIiwgdmFsdWUsIHJlc29sdmUsIHJlamVjdCk7XG4gICAgICAgICAgfSwgZnVuY3Rpb24oZXJyKSB7XG4gICAgICAgICAgICBpbnZva2UoXCJ0aHJvd1wiLCBlcnIsIHJlc29sdmUsIHJlamVjdCk7XG4gICAgICAgICAgfSk7XG4gICAgICAgIH1cblxuICAgICAgICByZXR1cm4gUHJvbWlzZS5yZXNvbHZlKHZhbHVlKS50aGVuKGZ1bmN0aW9uKHVud3JhcHBlZCkge1xuICAgICAgICAgIC8vIFdoZW4gYSB5aWVsZGVkIFByb21pc2UgaXMgcmVzb2x2ZWQsIGl0cyBmaW5hbCB2YWx1ZSBiZWNvbWVzXG4gICAgICAgICAgLy8gdGhlIC52YWx1ZSBvZiB0aGUgUHJvbWlzZTx7dmFsdWUsZG9uZX0+IHJlc3VsdCBmb3IgdGhlXG4gICAgICAgICAgLy8gY3VycmVudCBpdGVyYXRpb24uXG4gICAgICAgICAgcmVzdWx0LnZhbHVlID0gdW53cmFwcGVkO1xuICAgICAgICAgIHJlc29sdmUocmVzdWx0KTtcbiAgICAgICAgfSwgZnVuY3Rpb24oZXJyb3IpIHtcbiAgICAgICAgICAvLyBJZiBhIHJlamVjdGVkIFByb21pc2Ugd2FzIHlpZWxkZWQsIHRocm93IHRoZSByZWplY3Rpb24gYmFja1xuICAgICAgICAgIC8vIGludG8gdGhlIGFzeW5jIGdlbmVyYXRvciBmdW5jdGlvbiBzbyBpdCBjYW4gYmUgaGFuZGxlZCB0aGVyZS5cbiAgICAgICAgICByZXR1cm4gaW52b2tlKFwidGhyb3dcIiwgZXJyb3IsIHJlc29sdmUsIHJlamVjdCk7XG4gICAgICAgIH0pO1xuICAgICAgfVxuICAgIH1cblxuICAgIHZhciBwcmV2aW91c1Byb21pc2U7XG5cbiAgICBmdW5jdGlvbiBlbnF1ZXVlKG1ldGhvZCwgYXJnKSB7XG4gICAgICBmdW5jdGlvbiBjYWxsSW52b2tlV2l0aE1ldGhvZEFuZEFyZygpIHtcbiAgICAgICAgcmV0dXJuIG5ldyBQcm9taXNlKGZ1bmN0aW9uKHJlc29sdmUsIHJlamVjdCkge1xuICAgICAgICAgIGludm9rZShtZXRob2QsIGFyZywgcmVzb2x2ZSwgcmVqZWN0KTtcbiAgICAgICAgfSk7XG4gICAgICB9XG5cbiAgICAgIHJldHVybiBwcmV2aW91c1Byb21pc2UgPVxuICAgICAgICAvLyBJZiBlbnF1ZXVlIGhhcyBiZWVuIGNhbGxlZCBiZWZvcmUsIHRoZW4gd2Ugd2FudCB0byB3YWl0IHVudGlsXG4gICAgICAgIC8vIGFsbCBwcmV2aW91cyBQcm9taXNlcyBoYXZlIGJlZW4gcmVzb2x2ZWQgYmVmb3JlIGNhbGxpbmcgaW52b2tlLFxuICAgICAgICAvLyBzbyB0aGF0IHJlc3VsdHMgYXJlIGFsd2F5cyBkZWxpdmVyZWQgaW4gdGhlIGNvcnJlY3Qgb3JkZXIuIElmXG4gICAgICAgIC8vIGVucXVldWUgaGFzIG5vdCBiZWVuIGNhbGxlZCBiZWZvcmUsIHRoZW4gaXQgaXMgaW1wb3J0YW50IHRvXG4gICAgICAgIC8vIGNhbGwgaW52b2tlIGltbWVkaWF0ZWx5LCB3aXRob3V0IHdhaXRpbmcgb24gYSBjYWxsYmFjayB0byBmaXJlLFxuICAgICAgICAvLyBzbyB0aGF0IHRoZSBhc3luYyBnZW5lcmF0b3IgZnVuY3Rpb24gaGFzIHRoZSBvcHBvcnR1bml0eSB0byBkb1xuICAgICAgICAvLyBhbnkgbmVjZXNzYXJ5IHNldHVwIGluIGEgcHJlZGljdGFibGUgd2F5LiBUaGlzIHByZWRpY3RhYmlsaXR5XG4gICAgICAgIC8vIGlzIHdoeSB0aGUgUHJvbWlzZSBjb25zdHJ1Y3RvciBzeW5jaHJvbm91c2x5IGludm9rZXMgaXRzXG4gICAgICAgIC8vIGV4ZWN1dG9yIGNhbGxiYWNrLCBhbmQgd2h5IGFzeW5jIGZ1bmN0aW9ucyBzeW5jaHJvbm91c2x5XG4gICAgICAgIC8vIGV4ZWN1dGUgY29kZSBiZWZvcmUgdGhlIGZpcnN0IGF3YWl0LiBTaW5jZSB3ZSBpbXBsZW1lbnQgc2ltcGxlXG4gICAgICAgIC8vIGFzeW5jIGZ1bmN0aW9ucyBpbiB0ZXJtcyBvZiBhc3luYyBnZW5lcmF0b3JzLCBpdCBpcyBlc3BlY2lhbGx5XG4gICAgICAgIC8vIGltcG9ydGFudCB0byBnZXQgdGhpcyByaWdodCwgZXZlbiB0aG91Z2ggaXQgcmVxdWlyZXMgY2FyZS5cbiAgICAgICAgcHJldmlvdXNQcm9taXNlID8gcHJldmlvdXNQcm9taXNlLnRoZW4oXG4gICAgICAgICAgY2FsbEludm9rZVdpdGhNZXRob2RBbmRBcmcsXG4gICAgICAgICAgLy8gQXZvaWQgcHJvcGFnYXRpbmcgZmFpbHVyZXMgdG8gUHJvbWlzZXMgcmV0dXJuZWQgYnkgbGF0ZXJcbiAgICAgICAgICAvLyBpbnZvY2F0aW9ucyBvZiB0aGUgaXRlcmF0b3IuXG4gICAgICAgICAgY2FsbEludm9rZVdpdGhNZXRob2RBbmRBcmdcbiAgICAgICAgKSA6IGNhbGxJbnZva2VXaXRoTWV0aG9kQW5kQXJnKCk7XG4gICAgfVxuXG4gICAgLy8gRGVmaW5lIHRoZSB1bmlmaWVkIGhlbHBlciBtZXRob2QgdGhhdCBpcyB1c2VkIHRvIGltcGxlbWVudCAubmV4dCxcbiAgICAvLyAudGhyb3csIGFuZCAucmV0dXJuIChzZWUgZGVmaW5lSXRlcmF0b3JNZXRob2RzKS5cbiAgICB0aGlzLl9pbnZva2UgPSBlbnF1ZXVlO1xuICB9XG5cbiAgZGVmaW5lSXRlcmF0b3JNZXRob2RzKEFzeW5jSXRlcmF0b3IucHJvdG90eXBlKTtcbiAgQXN5bmNJdGVyYXRvci5wcm90b3R5cGVbYXN5bmNJdGVyYXRvclN5bWJvbF0gPSBmdW5jdGlvbiAoKSB7XG4gICAgcmV0dXJuIHRoaXM7XG4gIH07XG4gIGV4cG9ydHMuQXN5bmNJdGVyYXRvciA9IEFzeW5jSXRlcmF0b3I7XG5cbiAgLy8gTm90ZSB0aGF0IHNpbXBsZSBhc3luYyBmdW5jdGlvbnMgYXJlIGltcGxlbWVudGVkIG9uIHRvcCBvZlxuICAvLyBBc3luY0l0ZXJhdG9yIG9iamVjdHM7IHRoZXkganVzdCByZXR1cm4gYSBQcm9taXNlIGZvciB0aGUgdmFsdWUgb2ZcbiAgLy8gdGhlIGZpbmFsIHJlc3VsdCBwcm9kdWNlZCBieSB0aGUgaXRlcmF0b3IuXG4gIGV4cG9ydHMuYXN5bmMgPSBmdW5jdGlvbihpbm5lckZuLCBvdXRlckZuLCBzZWxmLCB0cnlMb2NzTGlzdCkge1xuICAgIHZhciBpdGVyID0gbmV3IEFzeW5jSXRlcmF0b3IoXG4gICAgICB3cmFwKGlubmVyRm4sIG91dGVyRm4sIHNlbGYsIHRyeUxvY3NMaXN0KVxuICAgICk7XG5cbiAgICByZXR1cm4gZXhwb3J0cy5pc0dlbmVyYXRvckZ1bmN0aW9uKG91dGVyRm4pXG4gICAgICA/IGl0ZXIgLy8gSWYgb3V0ZXJGbiBpcyBhIGdlbmVyYXRvciwgcmV0dXJuIHRoZSBmdWxsIGl0ZXJhdG9yLlxuICAgICAgOiBpdGVyLm5leHQoKS50aGVuKGZ1bmN0aW9uKHJlc3VsdCkge1xuICAgICAgICAgIHJldHVybiByZXN1bHQuZG9uZSA/IHJlc3VsdC52YWx1ZSA6IGl0ZXIubmV4dCgpO1xuICAgICAgICB9KTtcbiAgfTtcblxuICBmdW5jdGlvbiBtYWtlSW52b2tlTWV0aG9kKGlubmVyRm4sIHNlbGYsIGNvbnRleHQpIHtcbiAgICB2YXIgc3RhdGUgPSBHZW5TdGF0ZVN1c3BlbmRlZFN0YXJ0O1xuXG4gICAgcmV0dXJuIGZ1bmN0aW9uIGludm9rZShtZXRob2QsIGFyZykge1xuICAgICAgaWYgKHN0YXRlID09PSBHZW5TdGF0ZUV4ZWN1dGluZykge1xuICAgICAgICB0aHJvdyBuZXcgRXJyb3IoXCJHZW5lcmF0b3IgaXMgYWxyZWFkeSBydW5uaW5nXCIpO1xuICAgICAgfVxuXG4gICAgICBpZiAoc3RhdGUgPT09IEdlblN0YXRlQ29tcGxldGVkKSB7XG4gICAgICAgIGlmIChtZXRob2QgPT09IFwidGhyb3dcIikge1xuICAgICAgICAgIHRocm93IGFyZztcbiAgICAgICAgfVxuXG4gICAgICAgIC8vIEJlIGZvcmdpdmluZywgcGVyIDI1LjMuMy4zLjMgb2YgdGhlIHNwZWM6XG4gICAgICAgIC8vIGh0dHBzOi8vcGVvcGxlLm1vemlsbGEub3JnL35qb3JlbmRvcmZmL2VzNi1kcmFmdC5odG1sI3NlYy1nZW5lcmF0b3JyZXN1bWVcbiAgICAgICAgcmV0dXJuIGRvbmVSZXN1bHQoKTtcbiAgICAgIH1cblxuICAgICAgY29udGV4dC5tZXRob2QgPSBtZXRob2Q7XG4gICAgICBjb250ZXh0LmFyZyA9IGFyZztcblxuICAgICAgd2hpbGUgKHRydWUpIHtcbiAgICAgICAgdmFyIGRlbGVnYXRlID0gY29udGV4dC5kZWxlZ2F0ZTtcbiAgICAgICAgaWYgKGRlbGVnYXRlKSB7XG4gICAgICAgICAgdmFyIGRlbGVnYXRlUmVzdWx0ID0gbWF5YmVJbnZva2VEZWxlZ2F0ZShkZWxlZ2F0ZSwgY29udGV4dCk7XG4gICAgICAgICAgaWYgKGRlbGVnYXRlUmVzdWx0KSB7XG4gICAgICAgICAgICBpZiAoZGVsZWdhdGVSZXN1bHQgPT09IENvbnRpbnVlU2VudGluZWwpIGNvbnRpbnVlO1xuICAgICAgICAgICAgcmV0dXJuIGRlbGVnYXRlUmVzdWx0O1xuICAgICAgICAgIH1cbiAgICAgICAgfVxuXG4gICAgICAgIGlmIChjb250ZXh0Lm1ldGhvZCA9PT0gXCJuZXh0XCIpIHtcbiAgICAgICAgICAvLyBTZXR0aW5nIGNvbnRleHQuX3NlbnQgZm9yIGxlZ2FjeSBzdXBwb3J0IG9mIEJhYmVsJ3NcbiAgICAgICAgICAvLyBmdW5jdGlvbi5zZW50IGltcGxlbWVudGF0aW9uLlxuICAgICAgICAgIGNvbnRleHQuc2VudCA9IGNvbnRleHQuX3NlbnQgPSBjb250ZXh0LmFyZztcblxuICAgICAgICB9IGVsc2UgaWYgKGNvbnRleHQubWV0aG9kID09PSBcInRocm93XCIpIHtcbiAgICAgICAgICBpZiAoc3RhdGUgPT09IEdlblN0YXRlU3VzcGVuZGVkU3RhcnQpIHtcbiAgICAgICAgICAgIHN0YXRlID0gR2VuU3RhdGVDb21wbGV0ZWQ7XG4gICAgICAgICAgICB0aHJvdyBjb250ZXh0LmFyZztcbiAgICAgICAgICB9XG5cbiAgICAgICAgICBjb250ZXh0LmRpc3BhdGNoRXhjZXB0aW9uKGNvbnRleHQuYXJnKTtcblxuICAgICAgICB9IGVsc2UgaWYgKGNvbnRleHQubWV0aG9kID09PSBcInJldHVyblwiKSB7XG4gICAgICAgICAgY29udGV4dC5hYnJ1cHQoXCJyZXR1cm5cIiwgY29udGV4dC5hcmcpO1xuICAgICAgICB9XG5cbiAgICAgICAgc3RhdGUgPSBHZW5TdGF0ZUV4ZWN1dGluZztcblxuICAgICAgICB2YXIgcmVjb3JkID0gdHJ5Q2F0Y2goaW5uZXJGbiwgc2VsZiwgY29udGV4dCk7XG4gICAgICAgIGlmIChyZWNvcmQudHlwZSA9PT0gXCJub3JtYWxcIikge1xuICAgICAgICAgIC8vIElmIGFuIGV4Y2VwdGlvbiBpcyB0aHJvd24gZnJvbSBpbm5lckZuLCB3ZSBsZWF2ZSBzdGF0ZSA9PT1cbiAgICAgICAgICAvLyBHZW5TdGF0ZUV4ZWN1dGluZyBhbmQgbG9vcCBiYWNrIGZvciBhbm90aGVyIGludm9jYXRpb24uXG4gICAgICAgICAgc3RhdGUgPSBjb250ZXh0LmRvbmVcbiAgICAgICAgICAgID8gR2VuU3RhdGVDb21wbGV0ZWRcbiAgICAgICAgICAgIDogR2VuU3RhdGVTdXNwZW5kZWRZaWVsZDtcblxuICAgICAgICAgIGlmIChyZWNvcmQuYXJnID09PSBDb250aW51ZVNlbnRpbmVsKSB7XG4gICAgICAgICAgICBjb250aW51ZTtcbiAgICAgICAgICB9XG5cbiAgICAgICAgICByZXR1cm4ge1xuICAgICAgICAgICAgdmFsdWU6IHJlY29yZC5hcmcsXG4gICAgICAgICAgICBkb25lOiBjb250ZXh0LmRvbmVcbiAgICAgICAgICB9O1xuXG4gICAgICAgIH0gZWxzZSBpZiAocmVjb3JkLnR5cGUgPT09IFwidGhyb3dcIikge1xuICAgICAgICAgIHN0YXRlID0gR2VuU3RhdGVDb21wbGV0ZWQ7XG4gICAgICAgICAgLy8gRGlzcGF0Y2ggdGhlIGV4Y2VwdGlvbiBieSBsb29waW5nIGJhY2sgYXJvdW5kIHRvIHRoZVxuICAgICAgICAgIC8vIGNvbnRleHQuZGlzcGF0Y2hFeGNlcHRpb24oY29udGV4dC5hcmcpIGNhbGwgYWJvdmUuXG4gICAgICAgICAgY29udGV4dC5tZXRob2QgPSBcInRocm93XCI7XG4gICAgICAgICAgY29udGV4dC5hcmcgPSByZWNvcmQuYXJnO1xuICAgICAgICB9XG4gICAgICB9XG4gICAgfTtcbiAgfVxuXG4gIC8vIENhbGwgZGVsZWdhdGUuaXRlcmF0b3JbY29udGV4dC5tZXRob2RdKGNvbnRleHQuYXJnKSBhbmQgaGFuZGxlIHRoZVxuICAvLyByZXN1bHQsIGVpdGhlciBieSByZXR1cm5pbmcgYSB7IHZhbHVlLCBkb25lIH0gcmVzdWx0IGZyb20gdGhlXG4gIC8vIGRlbGVnYXRlIGl0ZXJhdG9yLCBvciBieSBtb2RpZnlpbmcgY29udGV4dC5tZXRob2QgYW5kIGNvbnRleHQuYXJnLFxuICAvLyBzZXR0aW5nIGNvbnRleHQuZGVsZWdhdGUgdG8gbnVsbCwgYW5kIHJldHVybmluZyB0aGUgQ29udGludWVTZW50aW5lbC5cbiAgZnVuY3Rpb24gbWF5YmVJbnZva2VEZWxlZ2F0ZShkZWxlZ2F0ZSwgY29udGV4dCkge1xuICAgIHZhciBtZXRob2QgPSBkZWxlZ2F0ZS5pdGVyYXRvcltjb250ZXh0Lm1ldGhvZF07XG4gICAgaWYgKG1ldGhvZCA9PT0gdW5kZWZpbmVkKSB7XG4gICAgICAvLyBBIC50aHJvdyBvciAucmV0dXJuIHdoZW4gdGhlIGRlbGVnYXRlIGl0ZXJhdG9yIGhhcyBubyAudGhyb3dcbiAgICAgIC8vIG1ldGhvZCBhbHdheXMgdGVybWluYXRlcyB0aGUgeWllbGQqIGxvb3AuXG4gICAgICBjb250ZXh0LmRlbGVnYXRlID0gbnVsbDtcblxuICAgICAgaWYgKGNvbnRleHQubWV0aG9kID09PSBcInRocm93XCIpIHtcbiAgICAgICAgLy8gTm90ZTogW1wicmV0dXJuXCJdIG11c3QgYmUgdXNlZCBmb3IgRVMzIHBhcnNpbmcgY29tcGF0aWJpbGl0eS5cbiAgICAgICAgaWYgKGRlbGVnYXRlLml0ZXJhdG9yW1wicmV0dXJuXCJdKSB7XG4gICAgICAgICAgLy8gSWYgdGhlIGRlbGVnYXRlIGl0ZXJhdG9yIGhhcyBhIHJldHVybiBtZXRob2QsIGdpdmUgaXQgYVxuICAgICAgICAgIC8vIGNoYW5jZSB0byBjbGVhbiB1cC5cbiAgICAgICAgICBjb250ZXh0Lm1ldGhvZCA9IFwicmV0dXJuXCI7XG4gICAgICAgICAgY29udGV4dC5hcmcgPSB1bmRlZmluZWQ7XG4gICAgICAgICAgbWF5YmVJbnZva2VEZWxlZ2F0ZShkZWxlZ2F0ZSwgY29udGV4dCk7XG5cbiAgICAgICAgICBpZiAoY29udGV4dC5tZXRob2QgPT09IFwidGhyb3dcIikge1xuICAgICAgICAgICAgLy8gSWYgbWF5YmVJbnZva2VEZWxlZ2F0ZShjb250ZXh0KSBjaGFuZ2VkIGNvbnRleHQubWV0aG9kIGZyb21cbiAgICAgICAgICAgIC8vIFwicmV0dXJuXCIgdG8gXCJ0aHJvd1wiLCBsZXQgdGhhdCBvdmVycmlkZSB0aGUgVHlwZUVycm9yIGJlbG93LlxuICAgICAgICAgICAgcmV0dXJuIENvbnRpbnVlU2VudGluZWw7XG4gICAgICAgICAgfVxuICAgICAgICB9XG5cbiAgICAgICAgY29udGV4dC5tZXRob2QgPSBcInRocm93XCI7XG4gICAgICAgIGNvbnRleHQuYXJnID0gbmV3IFR5cGVFcnJvcihcbiAgICAgICAgICBcIlRoZSBpdGVyYXRvciBkb2VzIG5vdCBwcm92aWRlIGEgJ3Rocm93JyBtZXRob2RcIik7XG4gICAgICB9XG5cbiAgICAgIHJldHVybiBDb250aW51ZVNlbnRpbmVsO1xuICAgIH1cblxuICAgIHZhciByZWNvcmQgPSB0cnlDYXRjaChtZXRob2QsIGRlbGVnYXRlLml0ZXJhdG9yLCBjb250ZXh0LmFyZyk7XG5cbiAgICBpZiAocmVjb3JkLnR5cGUgPT09IFwidGhyb3dcIikge1xuICAgICAgY29udGV4dC5tZXRob2QgPSBcInRocm93XCI7XG4gICAgICBjb250ZXh0LmFyZyA9IHJlY29yZC5hcmc7XG4gICAgICBjb250ZXh0LmRlbGVnYXRlID0gbnVsbDtcbiAgICAgIHJldHVybiBDb250aW51ZVNlbnRpbmVsO1xuICAgIH1cblxuICAgIHZhciBpbmZvID0gcmVjb3JkLmFyZztcblxuICAgIGlmICghIGluZm8pIHtcbiAgICAgIGNvbnRleHQubWV0aG9kID0gXCJ0aHJvd1wiO1xuICAgICAgY29udGV4dC5hcmcgPSBuZXcgVHlwZUVycm9yKFwiaXRlcmF0b3IgcmVzdWx0IGlzIG5vdCBhbiBvYmplY3RcIik7XG4gICAgICBjb250ZXh0LmRlbGVnYXRlID0gbnVsbDtcbiAgICAgIHJldHVybiBDb250aW51ZVNlbnRpbmVsO1xuICAgIH1cblxuICAgIGlmIChpbmZvLmRvbmUpIHtcbiAgICAgIC8vIEFzc2lnbiB0aGUgcmVzdWx0IG9mIHRoZSBmaW5pc2hlZCBkZWxlZ2F0ZSB0byB0aGUgdGVtcG9yYXJ5XG4gICAgICAvLyB2YXJpYWJsZSBzcGVjaWZpZWQgYnkgZGVsZWdhdGUucmVzdWx0TmFtZSAoc2VlIGRlbGVnYXRlWWllbGQpLlxuICAgICAgY29udGV4dFtkZWxlZ2F0ZS5yZXN1bHROYW1lXSA9IGluZm8udmFsdWU7XG5cbiAgICAgIC8vIFJlc3VtZSBleGVjdXRpb24gYXQgdGhlIGRlc2lyZWQgbG9jYXRpb24gKHNlZSBkZWxlZ2F0ZVlpZWxkKS5cbiAgICAgIGNvbnRleHQubmV4dCA9IGRlbGVnYXRlLm5leHRMb2M7XG5cbiAgICAgIC8vIElmIGNvbnRleHQubWV0aG9kIHdhcyBcInRocm93XCIgYnV0IHRoZSBkZWxlZ2F0ZSBoYW5kbGVkIHRoZVxuICAgICAgLy8gZXhjZXB0aW9uLCBsZXQgdGhlIG91dGVyIGdlbmVyYXRvciBwcm9jZWVkIG5vcm1hbGx5LiBJZlxuICAgICAgLy8gY29udGV4dC5tZXRob2Qgd2FzIFwibmV4dFwiLCBmb3JnZXQgY29udGV4dC5hcmcgc2luY2UgaXQgaGFzIGJlZW5cbiAgICAgIC8vIFwiY29uc3VtZWRcIiBieSB0aGUgZGVsZWdhdGUgaXRlcmF0b3IuIElmIGNvbnRleHQubWV0aG9kIHdhc1xuICAgICAgLy8gXCJyZXR1cm5cIiwgYWxsb3cgdGhlIG9yaWdpbmFsIC5yZXR1cm4gY2FsbCB0byBjb250aW51ZSBpbiB0aGVcbiAgICAgIC8vIG91dGVyIGdlbmVyYXRvci5cbiAgICAgIGlmIChjb250ZXh0Lm1ldGhvZCAhPT0gXCJyZXR1cm5cIikge1xuICAgICAgICBjb250ZXh0Lm1ldGhvZCA9IFwibmV4dFwiO1xuICAgICAgICBjb250ZXh0LmFyZyA9IHVuZGVmaW5lZDtcbiAgICAgIH1cblxuICAgIH0gZWxzZSB7XG4gICAgICAvLyBSZS15aWVsZCB0aGUgcmVzdWx0IHJldHVybmVkIGJ5IHRoZSBkZWxlZ2F0ZSBtZXRob2QuXG4gICAgICByZXR1cm4gaW5mbztcbiAgICB9XG5cbiAgICAvLyBUaGUgZGVsZWdhdGUgaXRlcmF0b3IgaXMgZmluaXNoZWQsIHNvIGZvcmdldCBpdCBhbmQgY29udGludWUgd2l0aFxuICAgIC8vIHRoZSBvdXRlciBnZW5lcmF0b3IuXG4gICAgY29udGV4dC5kZWxlZ2F0ZSA9IG51bGw7XG4gICAgcmV0dXJuIENvbnRpbnVlU2VudGluZWw7XG4gIH1cblxuICAvLyBEZWZpbmUgR2VuZXJhdG9yLnByb3RvdHlwZS57bmV4dCx0aHJvdyxyZXR1cm59IGluIHRlcm1zIG9mIHRoZVxuICAvLyB1bmlmaWVkIC5faW52b2tlIGhlbHBlciBtZXRob2QuXG4gIGRlZmluZUl0ZXJhdG9yTWV0aG9kcyhHcCk7XG5cbiAgR3BbdG9TdHJpbmdUYWdTeW1ib2xdID0gXCJHZW5lcmF0b3JcIjtcblxuICAvLyBBIEdlbmVyYXRvciBzaG91bGQgYWx3YXlzIHJldHVybiBpdHNlbGYgYXMgdGhlIGl0ZXJhdG9yIG9iamVjdCB3aGVuIHRoZVxuICAvLyBAQGl0ZXJhdG9yIGZ1bmN0aW9uIGlzIGNhbGxlZCBvbiBpdC4gU29tZSBicm93c2VycycgaW1wbGVtZW50YXRpb25zIG9mIHRoZVxuICAvLyBpdGVyYXRvciBwcm90b3R5cGUgY2hhaW4gaW5jb3JyZWN0bHkgaW1wbGVtZW50IHRoaXMsIGNhdXNpbmcgdGhlIEdlbmVyYXRvclxuICAvLyBvYmplY3QgdG8gbm90IGJlIHJldHVybmVkIGZyb20gdGhpcyBjYWxsLiBUaGlzIGVuc3VyZXMgdGhhdCBkb2Vzbid0IGhhcHBlbi5cbiAgLy8gU2VlIGh0dHBzOi8vZ2l0aHViLmNvbS9mYWNlYm9vay9yZWdlbmVyYXRvci9pc3N1ZXMvMjc0IGZvciBtb3JlIGRldGFpbHMuXG4gIEdwW2l0ZXJhdG9yU3ltYm9sXSA9IGZ1bmN0aW9uKCkge1xuICAgIHJldHVybiB0aGlzO1xuICB9O1xuXG4gIEdwLnRvU3RyaW5nID0gZnVuY3Rpb24oKSB7XG4gICAgcmV0dXJuIFwiW29iamVjdCBHZW5lcmF0b3JdXCI7XG4gIH07XG5cbiAgZnVuY3Rpb24gcHVzaFRyeUVudHJ5KGxvY3MpIHtcbiAgICB2YXIgZW50cnkgPSB7IHRyeUxvYzogbG9jc1swXSB9O1xuXG4gICAgaWYgKDEgaW4gbG9jcykge1xuICAgICAgZW50cnkuY2F0Y2hMb2MgPSBsb2NzWzFdO1xuICAgIH1cblxuICAgIGlmICgyIGluIGxvY3MpIHtcbiAgICAgIGVudHJ5LmZpbmFsbHlMb2MgPSBsb2NzWzJdO1xuICAgICAgZW50cnkuYWZ0ZXJMb2MgPSBsb2NzWzNdO1xuICAgIH1cblxuICAgIHRoaXMudHJ5RW50cmllcy5wdXNoKGVudHJ5KTtcbiAgfVxuXG4gIGZ1bmN0aW9uIHJlc2V0VHJ5RW50cnkoZW50cnkpIHtcbiAgICB2YXIgcmVjb3JkID0gZW50cnkuY29tcGxldGlvbiB8fCB7fTtcbiAgICByZWNvcmQudHlwZSA9IFwibm9ybWFsXCI7XG4gICAgZGVsZXRlIHJlY29yZC5hcmc7XG4gICAgZW50cnkuY29tcGxldGlvbiA9IHJlY29yZDtcbiAgfVxuXG4gIGZ1bmN0aW9uIENvbnRleHQodHJ5TG9jc0xpc3QpIHtcbiAgICAvLyBUaGUgcm9vdCBlbnRyeSBvYmplY3QgKGVmZmVjdGl2ZWx5IGEgdHJ5IHN0YXRlbWVudCB3aXRob3V0IGEgY2F0Y2hcbiAgICAvLyBvciBhIGZpbmFsbHkgYmxvY2spIGdpdmVzIHVzIGEgcGxhY2UgdG8gc3RvcmUgdmFsdWVzIHRocm93biBmcm9tXG4gICAgLy8gbG9jYXRpb25zIHdoZXJlIHRoZXJlIGlzIG5vIGVuY2xvc2luZyB0cnkgc3RhdGVtZW50LlxuICAgIHRoaXMudHJ5RW50cmllcyA9IFt7IHRyeUxvYzogXCJyb290XCIgfV07XG4gICAgdHJ5TG9jc0xpc3QuZm9yRWFjaChwdXNoVHJ5RW50cnksIHRoaXMpO1xuICAgIHRoaXMucmVzZXQodHJ1ZSk7XG4gIH1cblxuICBleHBvcnRzLmtleXMgPSBmdW5jdGlvbihvYmplY3QpIHtcbiAgICB2YXIga2V5cyA9IFtdO1xuICAgIGZvciAodmFyIGtleSBpbiBvYmplY3QpIHtcbiAgICAgIGtleXMucHVzaChrZXkpO1xuICAgIH1cbiAgICBrZXlzLnJldmVyc2UoKTtcblxuICAgIC8vIFJhdGhlciB0aGFuIHJldHVybmluZyBhbiBvYmplY3Qgd2l0aCBhIG5leHQgbWV0aG9kLCB3ZSBrZWVwXG4gICAgLy8gdGhpbmdzIHNpbXBsZSBhbmQgcmV0dXJuIHRoZSBuZXh0IGZ1bmN0aW9uIGl0c2VsZi5cbiAgICByZXR1cm4gZnVuY3Rpb24gbmV4dCgpIHtcbiAgICAgIHdoaWxlIChrZXlzLmxlbmd0aCkge1xuICAgICAgICB2YXIga2V5ID0ga2V5cy5wb3AoKTtcbiAgICAgICAgaWYgKGtleSBpbiBvYmplY3QpIHtcbiAgICAgICAgICBuZXh0LnZhbHVlID0ga2V5O1xuICAgICAgICAgIG5leHQuZG9uZSA9IGZhbHNlO1xuICAgICAgICAgIHJldHVybiBuZXh0O1xuICAgICAgICB9XG4gICAgICB9XG5cbiAgICAgIC8vIFRvIGF2b2lkIGNyZWF0aW5nIGFuIGFkZGl0aW9uYWwgb2JqZWN0LCB3ZSBqdXN0IGhhbmcgdGhlIC52YWx1ZVxuICAgICAgLy8gYW5kIC5kb25lIHByb3BlcnRpZXMgb2ZmIHRoZSBuZXh0IGZ1bmN0aW9uIG9iamVjdCBpdHNlbGYuIFRoaXNcbiAgICAgIC8vIGFsc28gZW5zdXJlcyB0aGF0IHRoZSBtaW5pZmllciB3aWxsIG5vdCBhbm9ueW1pemUgdGhlIGZ1bmN0aW9uLlxuICAgICAgbmV4dC5kb25lID0gdHJ1ZTtcbiAgICAgIHJldHVybiBuZXh0O1xuICAgIH07XG4gIH07XG5cbiAgZnVuY3Rpb24gdmFsdWVzKGl0ZXJhYmxlKSB7XG4gICAgaWYgKGl0ZXJhYmxlKSB7XG4gICAgICB2YXIgaXRlcmF0b3JNZXRob2QgPSBpdGVyYWJsZVtpdGVyYXRvclN5bWJvbF07XG4gICAgICBpZiAoaXRlcmF0b3JNZXRob2QpIHtcbiAgICAgICAgcmV0dXJuIGl0ZXJhdG9yTWV0aG9kLmNhbGwoaXRlcmFibGUpO1xuICAgICAgfVxuXG4gICAgICBpZiAodHlwZW9mIGl0ZXJhYmxlLm5leHQgPT09IFwiZnVuY3Rpb25cIikge1xuICAgICAgICByZXR1cm4gaXRlcmFibGU7XG4gICAgICB9XG5cbiAgICAgIGlmICghaXNOYU4oaXRlcmFibGUubGVuZ3RoKSkge1xuICAgICAgICB2YXIgaSA9IC0xLCBuZXh0ID0gZnVuY3Rpb24gbmV4dCgpIHtcbiAgICAgICAgICB3aGlsZSAoKytpIDwgaXRlcmFibGUubGVuZ3RoKSB7XG4gICAgICAgICAgICBpZiAoaGFzT3duLmNhbGwoaXRlcmFibGUsIGkpKSB7XG4gICAgICAgICAgICAgIG5leHQudmFsdWUgPSBpdGVyYWJsZVtpXTtcbiAgICAgICAgICAgICAgbmV4dC5kb25lID0gZmFsc2U7XG4gICAgICAgICAgICAgIHJldHVybiBuZXh0O1xuICAgICAgICAgICAgfVxuICAgICAgICAgIH1cblxuICAgICAgICAgIG5leHQudmFsdWUgPSB1bmRlZmluZWQ7XG4gICAgICAgICAgbmV4dC5kb25lID0gdHJ1ZTtcblxuICAgICAgICAgIHJldHVybiBuZXh0O1xuICAgICAgICB9O1xuXG4gICAgICAgIHJldHVybiBuZXh0Lm5leHQgPSBuZXh0O1xuICAgICAgfVxuICAgIH1cblxuICAgIC8vIFJldHVybiBhbiBpdGVyYXRvciB3aXRoIG5vIHZhbHVlcy5cbiAgICByZXR1cm4geyBuZXh0OiBkb25lUmVzdWx0IH07XG4gIH1cbiAgZXhwb3J0cy52YWx1ZXMgPSB2YWx1ZXM7XG5cbiAgZnVuY3Rpb24gZG9uZVJlc3VsdCgpIHtcbiAgICByZXR1cm4geyB2YWx1ZTogdW5kZWZpbmVkLCBkb25lOiB0cnVlIH07XG4gIH1cblxuICBDb250ZXh0LnByb3RvdHlwZSA9IHtcbiAgICBjb25zdHJ1Y3RvcjogQ29udGV4dCxcblxuICAgIHJlc2V0OiBmdW5jdGlvbihza2lwVGVtcFJlc2V0KSB7XG4gICAgICB0aGlzLnByZXYgPSAwO1xuICAgICAgdGhpcy5uZXh0ID0gMDtcbiAgICAgIC8vIFJlc2V0dGluZyBjb250ZXh0Ll9zZW50IGZvciBsZWdhY3kgc3VwcG9ydCBvZiBCYWJlbCdzXG4gICAgICAvLyBmdW5jdGlvbi5zZW50IGltcGxlbWVudGF0aW9uLlxuICAgICAgdGhpcy5zZW50ID0gdGhpcy5fc2VudCA9IHVuZGVmaW5lZDtcbiAgICAgIHRoaXMuZG9uZSA9IGZhbHNlO1xuICAgICAgdGhpcy5kZWxlZ2F0ZSA9IG51bGw7XG5cbiAgICAgIHRoaXMubWV0aG9kID0gXCJuZXh0XCI7XG4gICAgICB0aGlzLmFyZyA9IHVuZGVmaW5lZDtcblxuICAgICAgdGhpcy50cnlFbnRyaWVzLmZvckVhY2gocmVzZXRUcnlFbnRyeSk7XG5cbiAgICAgIGlmICghc2tpcFRlbXBSZXNldCkge1xuICAgICAgICBmb3IgKHZhciBuYW1lIGluIHRoaXMpIHtcbiAgICAgICAgICAvLyBOb3Qgc3VyZSBhYm91dCB0aGUgb3B0aW1hbCBvcmRlciBvZiB0aGVzZSBjb25kaXRpb25zOlxuICAgICAgICAgIGlmIChuYW1lLmNoYXJBdCgwKSA9PT0gXCJ0XCIgJiZcbiAgICAgICAgICAgICAgaGFzT3duLmNhbGwodGhpcywgbmFtZSkgJiZcbiAgICAgICAgICAgICAgIWlzTmFOKCtuYW1lLnNsaWNlKDEpKSkge1xuICAgICAgICAgICAgdGhpc1tuYW1lXSA9IHVuZGVmaW5lZDtcbiAgICAgICAgICB9XG4gICAgICAgIH1cbiAgICAgIH1cbiAgICB9LFxuXG4gICAgc3RvcDogZnVuY3Rpb24oKSB7XG4gICAgICB0aGlzLmRvbmUgPSB0cnVlO1xuXG4gICAgICB2YXIgcm9vdEVudHJ5ID0gdGhpcy50cnlFbnRyaWVzWzBdO1xuICAgICAgdmFyIHJvb3RSZWNvcmQgPSByb290RW50cnkuY29tcGxldGlvbjtcbiAgICAgIGlmIChyb290UmVjb3JkLnR5cGUgPT09IFwidGhyb3dcIikge1xuICAgICAgICB0aHJvdyByb290UmVjb3JkLmFyZztcbiAgICAgIH1cblxuICAgICAgcmV0dXJuIHRoaXMucnZhbDtcbiAgICB9LFxuXG4gICAgZGlzcGF0Y2hFeGNlcHRpb246IGZ1bmN0aW9uKGV4Y2VwdGlvbikge1xuICAgICAgaWYgKHRoaXMuZG9uZSkge1xuICAgICAgICB0aHJvdyBleGNlcHRpb247XG4gICAgICB9XG5cbiAgICAgIHZhciBjb250ZXh0ID0gdGhpcztcbiAgICAgIGZ1bmN0aW9uIGhhbmRsZShsb2MsIGNhdWdodCkge1xuICAgICAgICByZWNvcmQudHlwZSA9IFwidGhyb3dcIjtcbiAgICAgICAgcmVjb3JkLmFyZyA9IGV4Y2VwdGlvbjtcbiAgICAgICAgY29udGV4dC5uZXh0ID0gbG9jO1xuXG4gICAgICAgIGlmIChjYXVnaHQpIHtcbiAgICAgICAgICAvLyBJZiB0aGUgZGlzcGF0Y2hlZCBleGNlcHRpb24gd2FzIGNhdWdodCBieSBhIGNhdGNoIGJsb2NrLFxuICAgICAgICAgIC8vIHRoZW4gbGV0IHRoYXQgY2F0Y2ggYmxvY2sgaGFuZGxlIHRoZSBleGNlcHRpb24gbm9ybWFsbHkuXG4gICAgICAgICAgY29udGV4dC5tZXRob2QgPSBcIm5leHRcIjtcbiAgICAgICAgICBjb250ZXh0LmFyZyA9IHVuZGVmaW5lZDtcbiAgICAgICAgfVxuXG4gICAgICAgIHJldHVybiAhISBjYXVnaHQ7XG4gICAgICB9XG5cbiAgICAgIGZvciAodmFyIGkgPSB0aGlzLnRyeUVudHJpZXMubGVuZ3RoIC0gMTsgaSA+PSAwOyAtLWkpIHtcbiAgICAgICAgdmFyIGVudHJ5ID0gdGhpcy50cnlFbnRyaWVzW2ldO1xuICAgICAgICB2YXIgcmVjb3JkID0gZW50cnkuY29tcGxldGlvbjtcblxuICAgICAgICBpZiAoZW50cnkudHJ5TG9jID09PSBcInJvb3RcIikge1xuICAgICAgICAgIC8vIEV4Y2VwdGlvbiB0aHJvd24gb3V0c2lkZSBvZiBhbnkgdHJ5IGJsb2NrIHRoYXQgY291bGQgaGFuZGxlXG4gICAgICAgICAgLy8gaXQsIHNvIHNldCB0aGUgY29tcGxldGlvbiB2YWx1ZSBvZiB0aGUgZW50aXJlIGZ1bmN0aW9uIHRvXG4gICAgICAgICAgLy8gdGhyb3cgdGhlIGV4Y2VwdGlvbi5cbiAgICAgICAgICByZXR1cm4gaGFuZGxlKFwiZW5kXCIpO1xuICAgICAgICB9XG5cbiAgICAgICAgaWYgKGVudHJ5LnRyeUxvYyA8PSB0aGlzLnByZXYpIHtcbiAgICAgICAgICB2YXIgaGFzQ2F0Y2ggPSBoYXNPd24uY2FsbChlbnRyeSwgXCJjYXRjaExvY1wiKTtcbiAgICAgICAgICB2YXIgaGFzRmluYWxseSA9IGhhc093bi5jYWxsKGVudHJ5LCBcImZpbmFsbHlMb2NcIik7XG5cbiAgICAgICAgICBpZiAoaGFzQ2F0Y2ggJiYgaGFzRmluYWxseSkge1xuICAgICAgICAgICAgaWYgKHRoaXMucHJldiA8IGVudHJ5LmNhdGNoTG9jKSB7XG4gICAgICAgICAgICAgIHJldHVybiBoYW5kbGUoZW50cnkuY2F0Y2hMb2MsIHRydWUpO1xuICAgICAgICAgICAgfSBlbHNlIGlmICh0aGlzLnByZXYgPCBlbnRyeS5maW5hbGx5TG9jKSB7XG4gICAgICAgICAgICAgIHJldHVybiBoYW5kbGUoZW50cnkuZmluYWxseUxvYyk7XG4gICAgICAgICAgICB9XG5cbiAgICAgICAgICB9IGVsc2UgaWYgKGhhc0NhdGNoKSB7XG4gICAgICAgICAgICBpZiAodGhpcy5wcmV2IDwgZW50cnkuY2F0Y2hMb2MpIHtcbiAgICAgICAgICAgICAgcmV0dXJuIGhhbmRsZShlbnRyeS5jYXRjaExvYywgdHJ1ZSk7XG4gICAgICAgICAgICB9XG5cbiAgICAgICAgICB9IGVsc2UgaWYgKGhhc0ZpbmFsbHkpIHtcbiAgICAgICAgICAgIGlmICh0aGlzLnByZXYgPCBlbnRyeS5maW5hbGx5TG9jKSB7XG4gICAgICAgICAgICAgIHJldHVybiBoYW5kbGUoZW50cnkuZmluYWxseUxvYyk7XG4gICAgICAgICAgICB9XG5cbiAgICAgICAgICB9IGVsc2Uge1xuICAgICAgICAgICAgdGhyb3cgbmV3IEVycm9yKFwidHJ5IHN0YXRlbWVudCB3aXRob3V0IGNhdGNoIG9yIGZpbmFsbHlcIik7XG4gICAgICAgICAgfVxuICAgICAgICB9XG4gICAgICB9XG4gICAgfSxcblxuICAgIGFicnVwdDogZnVuY3Rpb24odHlwZSwgYXJnKSB7XG4gICAgICBmb3IgKHZhciBpID0gdGhpcy50cnlFbnRyaWVzLmxlbmd0aCAtIDE7IGkgPj0gMDsgLS1pKSB7XG4gICAgICAgIHZhciBlbnRyeSA9IHRoaXMudHJ5RW50cmllc1tpXTtcbiAgICAgICAgaWYgKGVudHJ5LnRyeUxvYyA8PSB0aGlzLnByZXYgJiZcbiAgICAgICAgICAgIGhhc093bi5jYWxsKGVudHJ5LCBcImZpbmFsbHlMb2NcIikgJiZcbiAgICAgICAgICAgIHRoaXMucHJldiA8IGVudHJ5LmZpbmFsbHlMb2MpIHtcbiAgICAgICAgICB2YXIgZmluYWxseUVudHJ5ID0gZW50cnk7XG4gICAgICAgICAgYnJlYWs7XG4gICAgICAgIH1cbiAgICAgIH1cblxuICAgICAgaWYgKGZpbmFsbHlFbnRyeSAmJlxuICAgICAgICAgICh0eXBlID09PSBcImJyZWFrXCIgfHxcbiAgICAgICAgICAgdHlwZSA9PT0gXCJjb250aW51ZVwiKSAmJlxuICAgICAgICAgIGZpbmFsbHlFbnRyeS50cnlMb2MgPD0gYXJnICYmXG4gICAgICAgICAgYXJnIDw9IGZpbmFsbHlFbnRyeS5maW5hbGx5TG9jKSB7XG4gICAgICAgIC8vIElnbm9yZSB0aGUgZmluYWxseSBlbnRyeSBpZiBjb250cm9sIGlzIG5vdCBqdW1waW5nIHRvIGFcbiAgICAgICAgLy8gbG9jYXRpb24gb3V0c2lkZSB0aGUgdHJ5L2NhdGNoIGJsb2NrLlxuICAgICAgICBmaW5hbGx5RW50cnkgPSBudWxsO1xuICAgICAgfVxuXG4gICAgICB2YXIgcmVjb3JkID0gZmluYWxseUVudHJ5ID8gZmluYWxseUVudHJ5LmNvbXBsZXRpb24gOiB7fTtcbiAgICAgIHJlY29yZC50eXBlID0gdHlwZTtcbiAgICAgIHJlY29yZC5hcmcgPSBhcmc7XG5cbiAgICAgIGlmIChmaW5hbGx5RW50cnkpIHtcbiAgICAgICAgdGhpcy5tZXRob2QgPSBcIm5leHRcIjtcbiAgICAgICAgdGhpcy5uZXh0ID0gZmluYWxseUVudHJ5LmZpbmFsbHlMb2M7XG4gICAgICAgIHJldHVybiBDb250aW51ZVNlbnRpbmVsO1xuICAgICAgfVxuXG4gICAgICByZXR1cm4gdGhpcy5jb21wbGV0ZShyZWNvcmQpO1xuICAgIH0sXG5cbiAgICBjb21wbGV0ZTogZnVuY3Rpb24ocmVjb3JkLCBhZnRlckxvYykge1xuICAgICAgaWYgKHJlY29yZC50eXBlID09PSBcInRocm93XCIpIHtcbiAgICAgICAgdGhyb3cgcmVjb3JkLmFyZztcbiAgICAgIH1cblxuICAgICAgaWYgKHJlY29yZC50eXBlID09PSBcImJyZWFrXCIgfHxcbiAgICAgICAgICByZWNvcmQudHlwZSA9PT0gXCJjb250aW51ZVwiKSB7XG4gICAgICAgIHRoaXMubmV4dCA9IHJlY29yZC5hcmc7XG4gICAgICB9IGVsc2UgaWYgKHJlY29yZC50eXBlID09PSBcInJldHVyblwiKSB7XG4gICAgICAgIHRoaXMucnZhbCA9IHRoaXMuYXJnID0gcmVjb3JkLmFyZztcbiAgICAgICAgdGhpcy5tZXRob2QgPSBcInJldHVyblwiO1xuICAgICAgICB0aGlzLm5leHQgPSBcImVuZFwiO1xuICAgICAgfSBlbHNlIGlmIChyZWNvcmQudHlwZSA9PT0gXCJub3JtYWxcIiAmJiBhZnRlckxvYykge1xuICAgICAgICB0aGlzLm5leHQgPSBhZnRlckxvYztcbiAgICAgIH1cblxuICAgICAgcmV0dXJuIENvbnRpbnVlU2VudGluZWw7XG4gICAgfSxcblxuICAgIGZpbmlzaDogZnVuY3Rpb24oZmluYWxseUxvYykge1xuICAgICAgZm9yICh2YXIgaSA9IHRoaXMudHJ5RW50cmllcy5sZW5ndGggLSAxOyBpID49IDA7IC0taSkge1xuICAgICAgICB2YXIgZW50cnkgPSB0aGlzLnRyeUVudHJpZXNbaV07XG4gICAgICAgIGlmIChlbnRyeS5maW5hbGx5TG9jID09PSBmaW5hbGx5TG9jKSB7XG4gICAgICAgICAgdGhpcy5jb21wbGV0ZShlbnRyeS5jb21wbGV0aW9uLCBlbnRyeS5hZnRlckxvYyk7XG4gICAgICAgICAgcmVzZXRUcnlFbnRyeShlbnRyeSk7XG4gICAgICAgICAgcmV0dXJuIENvbnRpbnVlU2VudGluZWw7XG4gICAgICAgIH1cbiAgICAgIH1cbiAgICB9LFxuXG4gICAgXCJjYXRjaFwiOiBmdW5jdGlvbih0cnlMb2MpIHtcbiAgICAgIGZvciAodmFyIGkgPSB0aGlzLnRyeUVudHJpZXMubGVuZ3RoIC0gMTsgaSA+PSAwOyAtLWkpIHtcbiAgICAgICAgdmFyIGVudHJ5ID0gdGhpcy50cnlFbnRyaWVzW2ldO1xuICAgICAgICBpZiAoZW50cnkudHJ5TG9jID09PSB0cnlMb2MpIHtcbiAgICAgICAgICB2YXIgcmVjb3JkID0gZW50cnkuY29tcGxldGlvbjtcbiAgICAgICAgICBpZiAocmVjb3JkLnR5cGUgPT09IFwidGhyb3dcIikge1xuICAgICAgICAgICAgdmFyIHRocm93biA9IHJlY29yZC5hcmc7XG4gICAgICAgICAgICByZXNldFRyeUVudHJ5KGVudHJ5KTtcbiAgICAgICAgICB9XG4gICAgICAgICAgcmV0dXJuIHRocm93bjtcbiAgICAgICAgfVxuICAgICAgfVxuXG4gICAgICAvLyBUaGUgY29udGV4dC5jYXRjaCBtZXRob2QgbXVzdCBvbmx5IGJlIGNhbGxlZCB3aXRoIGEgbG9jYXRpb25cbiAgICAgIC8vIGFyZ3VtZW50IHRoYXQgY29ycmVzcG9uZHMgdG8gYSBrbm93biBjYXRjaCBibG9jay5cbiAgICAgIHRocm93IG5ldyBFcnJvcihcImlsbGVnYWwgY2F0Y2ggYXR0ZW1wdFwiKTtcbiAgICB9LFxuXG4gICAgZGVsZWdhdGVZaWVsZDogZnVuY3Rpb24oaXRlcmFibGUsIHJlc3VsdE5hbWUsIG5leHRMb2MpIHtcbiAgICAgIHRoaXMuZGVsZWdhdGUgPSB7XG4gICAgICAgIGl0ZXJhdG9yOiB2YWx1ZXMoaXRlcmFibGUpLFxuICAgICAgICByZXN1bHROYW1lOiByZXN1bHROYW1lLFxuICAgICAgICBuZXh0TG9jOiBuZXh0TG9jXG4gICAgICB9O1xuXG4gICAgICBpZiAodGhpcy5tZXRob2QgPT09IFwibmV4dFwiKSB7XG4gICAgICAgIC8vIERlbGliZXJhdGVseSBmb3JnZXQgdGhlIGxhc3Qgc2VudCB2YWx1ZSBzbyB0aGF0IHdlIGRvbid0XG4gICAgICAgIC8vIGFjY2lkZW50YWxseSBwYXNzIGl0IG9uIHRvIHRoZSBkZWxlZ2F0ZS5cbiAgICAgICAgdGhpcy5hcmcgPSB1bmRlZmluZWQ7XG4gICAgICB9XG5cbiAgICAgIHJldHVybiBDb250aW51ZVNlbnRpbmVsO1xuICAgIH1cbiAgfTtcblxuICAvLyBSZWdhcmRsZXNzIG9mIHdoZXRoZXIgdGhpcyBzY3JpcHQgaXMgZXhlY3V0aW5nIGFzIGEgQ29tbW9uSlMgbW9kdWxlXG4gIC8vIG9yIG5vdCwgcmV0dXJuIHRoZSBydW50aW1lIG9iamVjdCBzbyB0aGF0IHdlIGNhbiBkZWNsYXJlIHRoZSB2YXJpYWJsZVxuICAvLyByZWdlbmVyYXRvclJ1bnRpbWUgaW4gdGhlIG91dGVyIHNjb3BlLCB3aGljaCBhbGxvd3MgdGhpcyBtb2R1bGUgdG8gYmVcbiAgLy8gaW5qZWN0ZWQgZWFzaWx5IGJ5IGBiaW4vcmVnZW5lcmF0b3IgLS1pbmNsdWRlLXJ1bnRpbWUgc2NyaXB0LmpzYC5cbiAgcmV0dXJuIGV4cG9ydHM7XG5cbn0oXG4gIC8vIElmIHRoaXMgc2NyaXB0IGlzIGV4ZWN1dGluZyBhcyBhIENvbW1vbkpTIG1vZHVsZSwgdXNlIG1vZHVsZS5leHBvcnRzXG4gIC8vIGFzIHRoZSByZWdlbmVyYXRvclJ1bnRpbWUgbmFtZXNwYWNlLiBPdGhlcndpc2UgY3JlYXRlIGEgbmV3IGVtcHR5XG4gIC8vIG9iamVjdC4gRWl0aGVyIHdheSwgdGhlIHJlc3VsdGluZyBvYmplY3Qgd2lsbCBiZSB1c2VkIHRvIGluaXRpYWxpemVcbiAgLy8gdGhlIHJlZ2VuZXJhdG9yUnVudGltZSB2YXJpYWJsZSBhdCB0aGUgdG9wIG9mIHRoaXMgZmlsZS5cbiAgdHlwZW9mIG1vZHVsZSA9PT0gXCJvYmplY3RcIiA/IG1vZHVsZS5leHBvcnRzIDoge31cbikpO1xuXG50cnkge1xuICByZWdlbmVyYXRvclJ1bnRpbWUgPSBydW50aW1lO1xufSBjYXRjaCAoYWNjaWRlbnRhbFN0cmljdE1vZGUpIHtcbiAgLy8gVGhpcyBtb2R1bGUgc2hvdWxkIG5vdCBiZSBydW5uaW5nIGluIHN0cmljdCBtb2RlLCBzbyB0aGUgYWJvdmVcbiAgLy8gYXNzaWdubWVudCBzaG91bGQgYWx3YXlzIHdvcmsgdW5sZXNzIHNvbWV0aGluZyBpcyBtaXNjb25maWd1cmVkLiBKdXN0XG4gIC8vIGluIGNhc2UgcnVudGltZS5qcyBhY2NpZGVudGFsbHkgcnVucyBpbiBzdHJpY3QgbW9kZSwgd2UgY2FuIGVzY2FwZVxuICAvLyBzdHJpY3QgbW9kZSB1c2luZyBhIGdsb2JhbCBGdW5jdGlvbiBjYWxsLiBUaGlzIGNvdWxkIGNvbmNlaXZhYmx5IGZhaWxcbiAgLy8gaWYgYSBDb250ZW50IFNlY3VyaXR5IFBvbGljeSBmb3JiaWRzIHVzaW5nIEZ1bmN0aW9uLCBidXQgaW4gdGhhdCBjYXNlXG4gIC8vIHRoZSBwcm9wZXIgc29sdXRpb24gaXMgdG8gZml4IHRoZSBhY2NpZGVudGFsIHN0cmljdCBtb2RlIHByb2JsZW0uIElmXG4gIC8vIHlvdSd2ZSBtaXNjb25maWd1cmVkIHlvdXIgYnVuZGxlciB0byBmb3JjZSBzdHJpY3QgbW9kZSBhbmQgYXBwbGllZCBhXG4gIC8vIENTUCB0byBmb3JiaWQgRnVuY3Rpb24sIGFuZCB5b3UncmUgbm90IHdpbGxpbmcgdG8gZml4IGVpdGhlciBvZiB0aG9zZVxuICAvLyBwcm9ibGVtcywgcGxlYXNlIGRldGFpbCB5b3VyIHVuaXF1ZSBwcmVkaWNhbWVudCBpbiBhIEdpdEh1YiBpc3N1ZS5cbiAgRnVuY3Rpb24oXCJyXCIsIFwicmVnZW5lcmF0b3JSdW50aW1lID0gclwiKShydW50aW1lKTtcbn1cbiIsImNvbnN0IHJlZ2VuZXJhdG9yUnVudGltZSA9IHJlcXVpcmUoXCJyZWdlbmVyYXRvci1ydW50aW1lXCIpO1xyXG5cclxuY29uc3QgdG9wbGluZSA9IGRvY3VtZW50LnF1ZXJ5U2VsZWN0b3IoXCIubWVudVwiKTtcclxuY29uc3QgbW9iaWxlTWVudSA9IGRvY3VtZW50LmdldEVsZW1lbnRCeUlkKFwibW9iaWxlTWVudVwiKTtcclxuY29uc3QgY2xvc2VCdG4gPSBkb2N1bWVudC5nZXRFbGVtZW50QnlJZChcImNsb3NlQnRuXCIpO1xyXG5jb25zdCBidXJnZXIgPSBkb2N1bWVudC5nZXRFbGVtZW50QnlJZChcImJ1cmdlclwiKTtcclxuY29uc3QgbW9iaWxlTGlzdCA9IGRvY3VtZW50LmdldEVsZW1lbnRCeUlkKFwibW9iaWxlTGlzdFwiKTtcclxuY29uc3Qgc2VlTW9yZSA9IGRvY3VtZW50LmdldEVsZW1lbnRCeUlkKFwic2VlTW9yZVwiKTtcclxuY29uc3QgYWNjb3JkZW9uID0gZG9jdW1lbnQuZ2V0RWxlbWVudEJ5SWQoXCJhY2NvcmRlb25cIik7XHJcbmNvbnN0IHJlYWRNb3JlMSA9IGRvY3VtZW50LmdldEVsZW1lbnRCeUlkKFwicmVhZE1vcmUxXCIpO1xyXG5jb25zdCBsaXN0Rmlyc3QgPSBkb2N1bWVudC5nZXRFbGVtZW50QnlJZChcImxpc3RGaXJzdFwiKTtcclxuY29uc3QgdGV4dEZpcnN0ID0gZG9jdW1lbnQuZ2V0RWxlbWVudEJ5SWQoXCJ0ZXh0Rmlyc3RcIik7XHJcbmNvbnN0IHRleHRTZWNvbmQgPSBkb2N1bWVudC5nZXRFbGVtZW50QnlJZChcInRleHRTZWNvbmRcIik7XHJcbmxldCBjb3VudGVyID0gMztcclxubGV0IHJhaXNlciA9IDM7XHJcbmNvbnN0IHByb2R1Y3RzID0gW1xyXG4gIHtcclxuICAgIHNyYzogXCJpbWcvMS4gSW5kb29yLmpwZ1wiLFxyXG4gICAgc3VidGl0bGU6IFwiSW5kb29yIGVuZXJneSBzZXJ2aWNlc1wiLFxyXG4gICAgdGV4dDpcclxuICAgICAgXCJXZSBoZWxwZWQgSW5kb29yIGVuZXJneSBzZXJ2aWNlcyB0byBncmVhdHkgc2ltcGxpZnkgdGhlaXIgY2FzZSBtYW5hZ2VtZW50IHN5c3RlbS4uLlwiXHJcbiAgfSxcclxuICB7XHJcbiAgICBzcmM6IFwiaW1nLzIuIEJpcmRpZS5qcGdcIixcclxuICAgIHN1YnRpdGxlOiBcIkJpcmRpZSBHb2xkIFRvdXJzXCIsXHJcbiAgICB0ZXh0OlxyXG4gICAgICBcIldlIGhlbHBlZCBCaXJkeSBHb2xmIFRvdXJzIHRvIHN0YXkgcmVsZXZlYW50IG9uIGFuIGluY2xyZWFzaW5nbHkgY29tcGV0aXRpdmUgbWFya2V0Li4uXCJcclxuICB9LFxyXG4gIHtcclxuICAgIHNyYzogXCJpbWcvMy4gTm93V2hlcmUuanBnXCIsXHJcbiAgICBzdWJ0aXRsZTogXCJOb3dXaGVyZVwiLFxyXG4gICAgdGV4dDpcclxuICAgICAgXCJXZSBidWlsdCBhIHJlY29tbWVuZGF0aW9ucyBhcHAgZm9yIHBlb3BsZSB3b3JraW5nIGluIGNyZWF0aXZlIGluZHVzdHJpZXMuLi5cIlxyXG4gIH0sXHJcbiAge1xyXG4gICAgc3JjOiBcImltZy80LiBGeW5kaXFzdmFqcGVuLmpwZ1wiLFxyXG4gICAgc3VidGl0bGU6IFwiRnluZGlxc3ZhanBlblwiLFxyXG4gICAgdGV4dDpcclxuICAgICAgXCJXZSBjcmVhdGVkIGFuIGFwcCB0aGF0IGhlbHBlZCBjdXN0b21lcnMgZmluZCBnaWZ0cyBhbW9uZyBtb3JlIHRoYW4gMjkwMDAwMCBpdGVtcy4uLlwiXHJcbiAgfSxcclxuICB7XHJcbiAgICBzcmM6IFwiaW1nLzUuIEJ5dGhqdWwuanBnXCIsXHJcbiAgICBzdWJ0aXRsZTogXCJCeXRoanVsXCIsXHJcbiAgICB0ZXh0OlxyXG4gICAgICBcIldlIGNyZWF0ZWQgdGlyZSBmYXNoaW9uIGZvciB0aGUgaW5jcmVhc2luZ2x5IGVnYWxpdGFyaWFuIGNhciBtYWludGluYWNlIG1hcmtldC4uLlwiXHJcbiAgfSxcclxuICB7XHJcbiAgICBzcmM6IFwiaW1nLzYuIFRpY2tpbi5qcGdcIixcclxuICAgIHN1YnRpdGxlOiBcIlRpY2tpblwiLFxyXG4gICAgdGV4dDpcclxuICAgICAgXCJXZSBpbnZlbnRlZCBhIHRpbWUgcmVwb3J0aW5nIHN5c3RlbSBmb3IgcGVvcGxlIHdobyBoYXRlIHRpbWUgdHJhY2tpbmcuLi5cIlxyXG4gIH0sXHJcbiAge1xyXG4gICAgc3JjOiBcImltZy83LiBVYmVybWVkcy5qcGdcIixcclxuICAgIHN1YnRpdGxlOiBcIlViZXJtZWRzXCIsXHJcbiAgICB0ZXh0OlxyXG4gICAgICBcIldlIGNyZWF0ZWQgYW4gYXBwIHRoYXQgaGVscGVkIGN1c3RvbWVycyBmaW5kIGdpZnRzIGFtb25nIG1vcmUgdGhhbiAyOTAwMDAwIGl0ZW1zLi4uXCJcclxuICB9LFxyXG4gIHtcclxuICAgIHNyYzogXCJpbWcvOC4gVsOkc3R0cmFmaWsgQ2FsY3VsYXRvci5qcGdcIixcclxuICAgIHN1YnRpdGxlOiBcIlbDpHN0dHJhZmlrIENhbGN1bGF0b3JcIixcclxuICAgIHRleHQ6XHJcbiAgICAgIFwiV2UgY3JlYXRlZCB0aXJlIGZhc2hpb24gZm9yIHRoZSBpbmNyZWFzaW5nbHkgZWdhbGl0YXJpYW4gY2FyIG1haW50aW5hY2UgbWFya2V0Li4uXCJcclxuICB9LFxyXG4gIHtcclxuICAgIHNyYzogXCJpbWcvOS4gVHLDpG5pbmdzcGFydG5lci5qcGdcIixcclxuICAgIHN1YnRpdGxlOiBcIlRyw6RuaW5nc3BhcnRuZXJcIixcclxuICAgIHRleHQ6XHJcbiAgICAgIFwiV2UgaW52ZW50ZWQgYSB0aW1lIHJlcG9ydGluZyBzeXN0ZW0gZm9yIHBlb3BsZSB3aG8gaGF0ZSB0aW1lIHRyYWNraW5nLi4uXCJcclxuICB9XHJcbl07XHJcblxyXG5kb2N1bWVudC5hZGRFdmVudExpc3RlbmVyKFwic2Nyb2xsXCIsICgpID0+IHtcclxuICBpZiAod2luZG93LnBhZ2VZT2Zmc2V0IDwgdG9wbGluZS5jbGllbnRIZWlnaHQpIHtcclxuICAgIHRvcGxpbmUuY2xhc3NMaXN0LnJlbW92ZShcImZpeGVkXCIpO1xyXG4gIH0gZWxzZSB7XHJcbiAgICB0b3BsaW5lLmNsYXNzTGlzdC5hZGQoXCJmaXhlZFwiKTtcclxuICB9XHJcbn0pO1xyXG5cclxuYnVyZ2VyLm9uY2xpY2sgPSBlID0+IHtcclxuICBlLnByZXZlbnREZWZhdWx0KCk7XHJcbiAgbW9iaWxlTWVudS5jbGFzc0xpc3QudG9nZ2xlKFwiaGlkZVwiKTtcclxufTtcclxuXHJcbmNsb3NlQnRuLm9uY2xpY2sgPSBlID0+IHtcclxuICBlLnByZXZlbnREZWZhdWx0KCk7XHJcbiAgbW9iaWxlTWVudS5jbGFzc0xpc3QudG9nZ2xlKFwiaGlkZVwiKTtcclxufTtcclxuXHJcbm1vYmlsZUxpc3Qub25jbGljayA9ICgpID0+IHtcclxuICBtb2JpbGVNZW51LmNsYXNzTGlzdC50b2dnbGUoXCJoaWRlXCIpO1xyXG59O1xyXG5cclxuYWNjb3JkZW9uLmFkZEV2ZW50TGlzdGVuZXIoXCJjbGlja1wiLCBlID0+IHtcclxuICBsZXQgdGFyZ2V0ID0gZS50YXJnZXQ7XHJcbiAgY29uc3QgbGlzdCA9IGRvY3VtZW50LmdldEVsZW1lbnRzQnlDbGFzc05hbWUoXCJob3ctd2UtZG9fX3RhYmxldC1pdGVtXCIpO1xyXG4gIGxldCBhcnIgPSBbLi4ubGlzdF07XHJcbiAgaWYgKHRhcmdldC5jbGFzc0xpc3QuY29udGFpbnMoJ3Nob3cnKSkge1xyXG4gICAgdGFyZ2V0LmNsYXNzTGlzdC50b2dnbGUoXCJzaG93XCIpO1xyXG4gIH0gZWxzZSB7XHJcbiAgICBhcnIubWFwKGkgPT4gaS5jbGFzc0xpc3QucmVtb3ZlKFwic2hvd1wiKSk7XHJcbiAgICB0YXJnZXQuY2xhc3NMaXN0LnRvZ2dsZShcInNob3dcIik7XHJcbiAgfVxyXG59KTtcclxuXHJcbnJlYWRNb3JlMS5vbmNsaWNrID0gZSA9PiB7XHJcbiAgZS5wcmV2ZW50RGVmYXVsdCgpO1xyXG4gIGxpc3RGaXJzdC5jbGFzc0xpc3QuYWRkKFwibW9yZVwiKTtcclxuICB0ZXh0Rmlyc3QuY2xhc3NMaXN0LmFkZChcIm1vcmVcIik7XHJcbn07XHJcblxyXG5yZWFkTW9yZTIub25jbGljayA9IGUgPT4ge1xyXG4gIGUucHJldmVudERlZmF1bHQoKTtcclxuICB0ZXh0U2Vjb25kLmNsYXNzTGlzdC5hZGQoXCJtb3JlXCIpO1xyXG59O1xyXG5cclxuY29uc3QgcmVuZGVyUHJvZHVjdHMgPSBpdGVtID0+IHtcclxuICByZXR1cm4gYDxkaXYgY2xhc3M9XCJjb2wtMTIgY29sLW1kLTYgY29sLWxnLTRcIj5cclxuICA8ZGl2IGNsYXNzPVwicHJvamVjdHNfX2NhcmRcIj5cclxuICAgIDxpbWcgc3JjPVwiJHtpdGVtLnNyY31cIiBhbHQ9XCJtYXNrXCI+XHJcbiAgICA8ZGl2IGNsYXNzPVwicHJvamVjdHNfX2luZm9cIj5cclxuICAgICAgPGg0IGNsYXNzPVwicHJvamVjdHNfX3N1YnRpdGxlXCI+JHtpdGVtLnN1YnRpdGxlfTwvaDQ+XHJcbiAgICAgIDxwIGNsYXNzPVwicHJvamVjdHNfX3RleHRcIj4ke2l0ZW0udGV4dH08L3A+XHJcbiAgICA8L2Rpdj5cclxuICA8L2Rpdj5cclxuPC9kaXY+YDtcclxufTtcclxuXHJcbmxldCByZW5kZXJTZWN0aW9uID0gcHJvamVjdHNEYXRhID0+IHtcclxuICBjb25zdCBwcm9qZWN0cyA9IHByb2plY3RzRGF0YS5tYXAoZWxlbWVudCA9PiByZW5kZXJQcm9kdWN0cyhlbGVtZW50KSk7XHJcbiAgZG9jdW1lbnQuZ2V0RWxlbWVudEJ5SWQoXCJwcm9qZWN0c1JlbmRlclwiKS5pbm5lckhUTUwgPSBwcm9qZWN0cy5qb2luKFwiXCIpO1xyXG59O1xyXG5cclxuc2VlTW9yZS5vbmNsaWNrID0gZSA9PiB7XHJcbiAgZS5wcmV2ZW50RGVmYXVsdCgpO1xyXG4gIGNvdW50ZXIgKz0gcmFpc2VyO1xyXG4gIHJlbmRlclNlY3Rpb24ocHJvZHVjdHMuc2xpY2UoMCwgY291bnRlcikpO1xyXG59O1xyXG5cclxud2luZG93LmFkZEV2ZW50TGlzdGVuZXIoXCJET01Db250ZW50TG9hZGVkXCIsICgpID0+IHtcclxuICBjb25zdCB3aXRkaENvdW50ZXIgPSBhc3luYyAoKSA9PiB7XHJcbiAgICBzd2l0Y2ggKHRydWUpIHtcclxuICAgICAgY2FzZSBkb2N1bWVudC5kb2N1bWVudEVsZW1lbnQuY2xpZW50V2lkdGggPiA3Njg6XHJcbiAgICAgICAgY291bnRlciA9IDk7XHJcbiAgICAgICAgYnJlYWs7XHJcbiAgICAgIGNhc2UgZG9jdW1lbnQuZG9jdW1lbnRFbGVtZW50LmNsaWVudFdpZHRoID4gNDE0OlxyXG4gICAgICAgIGNvdW50ZXIgPSA0O1xyXG4gICAgICAgIHJhaXNlciA9IDQ7XHJcbiAgICAgICAgYnJlYWs7XHJcbiAgICAgIGRlZmF1bHQ6XHJcbiAgICAgICAgY291bnRlciA9IDM7XHJcbiAgICAgICAgcmFpc2VyID0gMztcclxuICAgICAgICBicmVhaztcclxuICAgIH1cclxuICB9O1xyXG4gIHdpdGRoQ291bnRlcigpO1xyXG4gIHJlbmRlclNlY3Rpb24ocHJvZHVjdHMuc2xpY2UoMCwgY291bnRlcikpO1xyXG59KTtcclxuIl0sInByZUV4aXN0aW5nQ29tbWVudCI6Ii8vIyBzb3VyY2VNYXBwaW5nVVJMPWRhdGE6YXBwbGljYXRpb24vanNvbjtjaGFyc2V0PXV0Zi04O2Jhc2U2NCxleUoyWlhKemFXOXVJam96TENKemIzVnlZMlZ6SWpwYkltNXZaR1ZmYlc5a2RXeGxjeTlpY205M2MyVnlMWEJoWTJzdlgzQnlaV3gxWkdVdWFuTWlMQ0p1YjJSbFgyMXZaSFZzWlhNdmNtVm5aVzVsY21GMGIzSXRjblZ1ZEdsdFpTOXlkVzUwYVcxbExtcHpJaXdpY0hKdmFtVmpkSE12ZDJocGRHVndiM0owTFhOcGRHVXZjM0pqTDJwekwyRndjQzVxY3lKZExDSnVZVzFsY3lJNlcxMHNJbTFoY0hCcGJtZHpJam9pUVVGQlFUdEJRMEZCTzBGQlEwRTdRVUZEUVR0QlFVTkJPMEZCUTBFN1FVRkRRVHRCUVVOQk8wRkJRMEU3UVVGRFFUdEJRVU5CTzBGQlEwRTdRVUZEUVR0QlFVTkJPMEZCUTBFN1FVRkRRVHRCUVVOQk8wRkJRMEU3UVVGRFFUdEJRVU5CTzBGQlEwRTdRVUZEUVR0QlFVTkJPMEZCUTBFN1FVRkRRVHRCUVVOQk8wRkJRMEU3UVVGRFFUdEJRVU5CTzBGQlEwRTdRVUZEUVR0QlFVTkJPMEZCUTBFN1FVRkRRVHRCUVVOQk8wRkJRMEU3UVVGRFFUdEJRVU5CTzBGQlEwRTdRVUZEUVR0QlFVTkJPMEZCUTBFN1FVRkRRVHRCUVVOQk8wRkJRMEU3UVVGRFFUdEJRVU5CTzBGQlEwRTdRVUZEUVR0QlFVTkJPMEZCUTBFN1FVRkRRVHRCUVVOQk8wRkJRMEU3UVVGRFFUdEJRVU5CTzBGQlEwRTdRVUZEUVR0QlFVTkJPMEZCUTBFN1FVRkRRVHRCUVVOQk8wRkJRMEU3UVVGRFFUdEJRVU5CTzBGQlEwRTdRVUZEUVR0QlFVTkJPMEZCUTBFN1FVRkRRVHRCUVVOQk8wRkJRMEU3UVVGRFFUdEJRVU5CTzBGQlEwRTdRVUZEUVR0QlFVTkJPMEZCUTBFN1FVRkRRVHRCUVVOQk8wRkJRMEU3UVVGRFFUdEJRVU5CTzBGQlEwRTdRVUZEUVR0QlFVTkJPMEZCUTBFN1FVRkRRVHRCUVVOQk8wRkJRMEU3UVVGRFFUdEJRVU5CTzBGQlEwRTdRVUZEUVR0QlFVTkJPMEZCUTBFN1FVRkRRVHRCUVVOQk8wRkJRMEU3UVVGRFFUdEJRVU5CTzBGQlEwRTdRVUZEUVR0QlFVTkJPMEZCUTBFN1FVRkRRVHRCUVVOQk8wRkJRMEU3UVVGRFFUdEJRVU5CTzBGQlEwRTdRVUZEUVR0QlFVTkJPMEZCUTBFN1FVRkRRVHRCUVVOQk8wRkJRMEU3UVVGRFFUdEJRVU5CTzBGQlEwRTdRVUZEUVR0QlFVTkJPMEZCUTBFN1FVRkRRVHRCUVVOQk8wRkJRMEU3UVVGRFFUdEJRVU5CTzBGQlEwRTdRVUZEUVR0QlFVTkJPMEZCUTBFN1FVRkRRVHRCUVVOQk8wRkJRMEU3UVVGRFFUdEJRVU5CTzBGQlEwRTdRVUZEUVR0QlFVTkJPMEZCUTBFN1FVRkRRVHRCUVVOQk8wRkJRMEU3UVVGRFFUdEJRVU5CTzBGQlEwRTdRVUZEUVR0QlFVTkJPMEZCUTBFN1FVRkRRVHRCUVVOQk8wRkJRMEU3UVVGRFFUdEJRVU5CTzBGQlEwRTdRVUZEUVR0QlFVTkJPMEZCUTBFN1FVRkRRVHRCUVVOQk8wRkJRMEU3UVVGRFFUdEJRVU5CTzBGQlEwRTdRVUZEUVR0QlFVTkJPMEZCUTBFN1FVRkRRVHRCUVVOQk8wRkJRMEU3UVVGRFFUdEJRVU5CTzBGQlEwRTdRVUZEUVR0QlFVTkJPMEZCUTBFN1FVRkRRVHRCUVVOQk8wRkJRMEU3UVVGRFFUdEJRVU5CTzBGQlEwRTdRVUZEUVR0QlFVTkJPMEZCUTBFN1FVRkRRVHRCUVVOQk8wRkJRMEU3UVVGRFFUdEJRVU5CTzBGQlEwRTdRVUZEUVR0QlFVTkJPMEZCUTBFN1FVRkRRVHRCUVVOQk8wRkJRMEU3UVVGRFFUdEJRVU5CTzBGQlEwRTdRVUZEUVR0QlFVTkJPMEZCUTBFN1FVRkRRVHRCUVVOQk8wRkJRMEU3UVVGRFFUdEJRVU5CTzBGQlEwRTdRVUZEUVR0QlFVTkJPMEZCUTBFN1FVRkRRVHRCUVVOQk8wRkJRMEU3UVVGRFFUdEJRVU5CTzBGQlEwRTdRVUZEUVR0QlFVTkJPMEZCUTBFN1FVRkRRVHRCUVVOQk8wRkJRMEU3UVVGRFFUdEJRVU5CTzBGQlEwRTdRVUZEUVR0QlFVTkJPMEZCUTBFN1FVRkRRVHRCUVVOQk8wRkJRMEU3UVVGRFFUdEJRVU5CTzBGQlEwRTdRVUZEUVR0QlFVTkJPMEZCUTBFN1FVRkRRVHRCUVVOQk8wRkJRMEU3UVVGRFFUdEJRVU5CTzBGQlEwRTdRVUZEUVR0QlFVTkJPMEZCUTBFN1FVRkRRVHRCUVVOQk8wRkJRMEU3UVVGRFFUdEJRVU5CTzBGQlEwRTdRVUZEUVR0QlFVTkJPMEZCUTBFN1FVRkRRVHRCUVVOQk8wRkJRMEU3UVVGRFFUdEJRVU5CTzBGQlEwRTdRVUZEUVR0QlFVTkJPMEZCUTBFN1FVRkRRVHRCUVVOQk8wRkJRMEU3UVVGRFFUdEJRVU5CTzBGQlEwRTdRVUZEUVR0QlFVTkJPMEZCUTBFN1FVRkRRVHRCUVVOQk8wRkJRMEU3UVVGRFFUdEJRVU5CTzBGQlEwRTdRVUZEUVR0QlFVTkJPMEZCUTBFN1FVRkRRVHRCUVVOQk8wRkJRMEU3UVVGRFFUdEJRVU5CTzBGQlEwRTdRVUZEUVR0QlFVTkJPMEZCUTBFN1FVRkRRVHRCUVVOQk8wRkJRMEU3UVVGRFFUdEJRVU5CTzBGQlEwRTdRVUZEUVR0QlFVTkJPMEZCUTBFN1FVRkRRVHRCUVVOQk8wRkJRMEU3UVVGRFFUdEJRVU5CTzBGQlEwRTdRVUZEUVR0QlFVTkJPMEZCUTBFN1FVRkRRVHRCUVVOQk8wRkJRMEU3UVVGRFFUdEJRVU5CTzBGQlEwRTdRVUZEUVR0QlFVTkJPMEZCUTBFN1FVRkRRVHRCUVVOQk8wRkJRMEU3UVVGRFFUdEJRVU5CTzBGQlEwRTdRVUZEUVR0QlFVTkJPMEZCUTBFN1FVRkRRVHRCUVVOQk8wRkJRMEU3UVVGRFFUdEJRVU5CTzBGQlEwRTdRVUZEUVR0QlFVTkJPMEZCUTBFN1FVRkRRVHRCUVVOQk8wRkJRMEU3UVVGRFFUdEJRVU5CTzBGQlEwRTdRVUZEUVR0QlFVTkJPMEZCUTBFN1FVRkRRVHRCUVVOQk8wRkJRMEU3UVVGRFFUdEJRVU5CTzBGQlEwRTdRVUZEUVR0QlFVTkJPMEZCUTBFN1FVRkRRVHRCUVVOQk8wRkJRMEU3UVVGRFFUdEJRVU5CTzBGQlEwRTdRVUZEUVR0QlFVTkJPMEZCUTBFN1FVRkRRVHRCUVVOQk8wRkJRMEU3UVVGRFFUdEJRVU5CTzBGQlEwRTdRVUZEUVR0QlFVTkJPMEZCUTBFN1FVRkRRVHRCUVVOQk8wRkJRMEU3UVVGRFFUdEJRVU5CTzBGQlEwRTdRVUZEUVR0QlFVTkJPMEZCUTBFN1FVRkRRVHRCUVVOQk8wRkJRMEU3UVVGRFFUdEJRVU5CTzBGQlEwRTdRVUZEUVR0QlFVTkJPMEZCUTBFN1FVRkRRVHRCUVVOQk8wRkJRMEU3UVVGRFFUdEJRVU5CTzBGQlEwRTdRVUZEUVR0QlFVTkJPMEZCUTBFN1FVRkRRVHRCUVVOQk8wRkJRMEU3UVVGRFFUdEJRVU5CTzBGQlEwRTdRVUZEUVR0QlFVTkJPMEZCUTBFN1FVRkRRVHRCUVVOQk8wRkJRMEU3UVVGRFFUdEJRVU5CTzBGQlEwRTdRVUZEUVR0QlFVTkJPMEZCUTBFN1FVRkRRVHRCUVVOQk8wRkJRMEU3UVVGRFFUdEJRVU5CTzBGQlEwRTdRVUZEUVR0QlFVTkJPMEZCUTBFN1FVRkRRVHRCUVVOQk8wRkJRMEU3UVVGRFFUdEJRVU5CTzBGQlEwRTdRVUZEUVR0QlFVTkJPMEZCUTBFN1FVRkRRVHRCUVVOQk8wRkJRMEU3UVVGRFFUdEJRVU5CTzBGQlEwRTdRVUZEUVR0QlFVTkJPMEZCUTBFN1FVRkRRVHRCUVVOQk8wRkJRMEU3UVVGRFFUdEJRVU5CTzBGQlEwRTdRVUZEUVR0QlFVTkJPMEZCUTBFN1FVRkRRVHRCUVVOQk8wRkJRMEU3UVVGRFFUdEJRVU5CTzBGQlEwRTdRVUZEUVR0QlFVTkJPMEZCUTBFN1FVRkRRVHRCUVVOQk8wRkJRMEU3UVVGRFFUdEJRVU5CTzBGQlEwRTdRVUZEUVR0QlFVTkJPMEZCUTBFN1FVRkRRVHRCUVVOQk8wRkJRMEU3UVVGRFFUdEJRVU5CTzBGQlEwRTdRVUZEUVR0QlFVTkJPMEZCUTBFN1FVRkRRVHRCUVVOQk8wRkJRMEU3UVVGRFFUdEJRVU5CTzBGQlEwRTdRVUZEUVR0QlFVTkJPMEZCUTBFN1FVRkRRVHRCUVVOQk8wRkJRMEU3UVVGRFFUdEJRVU5CTzBGQlEwRTdRVUZEUVR0QlFVTkJPMEZCUTBFN1FVRkRRVHRCUVVOQk8wRkJRMEU3UVVGRFFUdEJRVU5CTzBGQlEwRTdRVUZEUVR0QlFVTkJPMEZCUTBFN1FVRkRRVHRCUVVOQk8wRkJRMEU3UVVGRFFUdEJRVU5CTzBGQlEwRTdRVUZEUVR0QlFVTkJPMEZCUTBFN1FVRkRRVHRCUVVOQk8wRkJRMEU3UVVGRFFUdEJRVU5CTzBGQlEwRTdRVUZEUVR0QlFVTkJPMEZCUTBFN1FVRkRRVHRCUVVOQk8wRkJRMEU3UVVGRFFUdEJRVU5CTzBGQlEwRTdRVUZEUVR0QlFVTkJPMEZCUTBFN1FVRkRRVHRCUVVOQk8wRkJRMEU3UVVGRFFUdEJRVU5CTzBGQlEwRTdRVUZEUVR0QlFVTkJPMEZCUTBFN1FVRkRRVHRCUVVOQk8wRkJRMEU3UVVGRFFUdEJRVU5CTzBGQlEwRTdRVUZEUVR0QlFVTkJPMEZCUTBFN1FVRkRRVHRCUVVOQk8wRkJRMEU3UVVGRFFUdEJRVU5CTzBGQlEwRTdRVUZEUVR0QlFVTkJPMEZCUTBFN1FVRkRRVHRCUVVOQk8wRkJRMEU3UVVGRFFUdEJRVU5CTzBGQlEwRTdRVUZEUVR0QlFVTkJPMEZCUTBFN1FVRkRRVHRCUVVOQk8wRkJRMEU3UVVGRFFUdEJRVU5CTzBGQlEwRTdRVUZEUVR0QlFVTkJPMEZCUTBFN1FVRkRRVHRCUVVOQk8wRkJRMEU3UVVGRFFUdEJRVU5CTzBGQlEwRTdRVUZEUVR0QlFVTkJPMEZCUTBFN1FVRkRRVHRCUVVOQk8wRkJRMEU3UVVGRFFUdEJRVU5CTzBGQlEwRTdRVUZEUVR0QlFVTkJPMEZCUTBFN1FVRkRRVHRCUVVOQk8wRkJRMEU3UVVGRFFUdEJRVU5CTzBGQlEwRTdRVUZEUVR0QlFVTkJPMEZCUTBFN1FVRkRRVHRCUVVOQk8wRkJRMEU3UVVGRFFUdEJRVU5CTzBGQlEwRTdRVUZEUVR0QlFVTkJPMEZCUTBFN1FVRkRRVHRCUVVOQk8wRkJRMEU3UVVGRFFUdEJRVU5CTzBGQlEwRTdRVUZEUVR0QlFVTkJPMEZCUTBFN1FVRkRRVHRCUVVOQk8wRkJRMEU3UVVGRFFUdEJRVU5CTzBGQlEwRTdRVUZEUVR0QlFVTkJPMEZCUTBFN1FVRkRRVHRCUVVOQk8wRkJRMEU3UVVGRFFUdEJRVU5CTzBGQlEwRTdRVUZEUVR0QlFVTkJPMEZCUTBFN1FVRkRRVHRCUVVOQk8wRkJRMEU3UVVGRFFUdEJRVU5CTzBGQlEwRTdRVUZEUVR0QlFVTkJPMEZCUTBFN1FVRkRRVHRCUVVOQk8wRkJRMEU3UVVGRFFUdEJRVU5CTzBGQlEwRTdRVUZEUVR0QlFVTkJPMEZCUTBFN1FVRkRRVHRCUVVOQk8wRkJRMEU3UVVGRFFUdEJRVU5CTzBGQlEwRTdRVUZEUVR0QlFVTkJPMEZCUTBFN1FVRkRRVHRCUVVOQk8wRkJRMEU3UVVGRFFUdEJRVU5CTzBGQlEwRTdRVUZEUVR0QlFVTkJPMEZCUTBFN1FVRkRRVHRCUVVOQk8wRkJRMEU3UVVGRFFUdEJRVU5CTzBGQlEwRTdRVUZEUVR0QlFVTkJPMEZCUTBFN1FVRkRRVHRCUVVOQk8wRkJRMEU3UVVGRFFUdEJRVU5CTzBGQlEwRTdRVUZEUVR0QlFVTkJPMEZCUTBFN1FVRkRRVHRCUVVOQk8wRkJRMEU3UVVGRFFUdEJRVU5CTzBGQlEwRTdRVUZEUVR0QlFVTkJPMEZCUTBFN1FVRkRRVHRCUVVOQk8wRkJRMEU3UVVGRFFUdEJRVU5CTzBGQlEwRTdRVUZEUVR0QlFVTkJPMEZCUTBFN1FVRkRRVHRCUVVOQk8wRkJRMEU3UVVGRFFUdEJRVU5CTzBGQlEwRTdRVUZEUVR0QlFVTkJPMEZCUTBFN1FVRkRRVHRCUVVOQk96czdPenM3T3pzN096czdRVU4wZEVKQkxFbEJRVTBzYTBKQlFXdENMRWRCUVVjc1QwRkJUeXhEUVVGRExIRkNRVUZFTEVOQlFXeERPenRCUVVWQkxFbEJRVTBzVDBGQlR5eEhRVUZITEZGQlFWRXNRMEZCUXl4aFFVRlVMRU5CUVhWQ0xFOUJRWFpDTEVOQlFXaENPMEZCUTBFc1NVRkJUU3hWUVVGVkxFZEJRVWNzVVVGQlVTeERRVUZETEdOQlFWUXNRMEZCZDBJc1dVRkJlRUlzUTBGQmJrSTdRVUZEUVN4SlFVRk5MRkZCUVZFc1IwRkJSeXhSUVVGUkxFTkJRVU1zWTBGQlZDeERRVUYzUWl4VlFVRjRRaXhEUVVGcVFqdEJRVU5CTEVsQlFVMHNUVUZCVFN4SFFVRkhMRkZCUVZFc1EwRkJReXhqUVVGVUxFTkJRWGRDTEZGQlFYaENMRU5CUVdZN1FVRkRRU3hKUVVGTkxGVkJRVlVzUjBGQlJ5eFJRVUZSTEVOQlFVTXNZMEZCVkN4RFFVRjNRaXhaUVVGNFFpeERRVUZ1UWp0QlFVTkJMRWxCUVUwc1QwRkJUeXhIUVVGSExGRkJRVkVzUTBGQlF5eGpRVUZVTEVOQlFYZENMRk5CUVhoQ0xFTkJRV2hDTzBGQlEwRXNTVUZCVFN4VFFVRlRMRWRCUVVjc1VVRkJVU3hEUVVGRExHTkJRVlFzUTBGQmQwSXNWMEZCZUVJc1EwRkJiRUk3UVVGRFFTeEpRVUZOTEZOQlFWTXNSMEZCUnl4UlFVRlJMRU5CUVVNc1kwRkJWQ3hEUVVGM1FpeFhRVUY0UWl4RFFVRnNRanRCUVVOQkxFbEJRVTBzVTBGQlV5eEhRVUZITEZGQlFWRXNRMEZCUXl4alFVRlVMRU5CUVhkQ0xGZEJRWGhDTEVOQlFXeENPMEZCUTBFc1NVRkJUU3hUUVVGVExFZEJRVWNzVVVGQlVTeERRVUZETEdOQlFWUXNRMEZCZDBJc1YwRkJlRUlzUTBGQmJFSTdRVUZEUVN4SlFVRk5MRlZCUVZVc1IwRkJSeXhSUVVGUkxFTkJRVU1zWTBGQlZDeERRVUYzUWl4WlFVRjRRaXhEUVVGdVFqdEJRVU5CTEVsQlFVa3NUMEZCVHl4SFFVRkhMRU5CUVdRN1FVRkRRU3hKUVVGSkxFMUJRVTBzUjBGQlJ5eERRVUZpTzBGQlEwRXNTVUZCVFN4UlFVRlJMRWRCUVVjc1EwRkRaanRCUVVORkxFVkJRVUVzUjBGQlJ5eEZRVUZGTEcxQ1FVUlFPMEZCUlVVc1JVRkJRU3hSUVVGUkxFVkJRVVVzZDBKQlJsbzdRVUZIUlN4RlFVRkJMRWxCUVVrc1JVRkRSanRCUVVwS0xFTkJSR1VzUlVGUFpqdEJRVU5GTEVWQlFVRXNSMEZCUnl4RlFVRkZMRzFDUVVSUU8wRkJSVVVzUlVGQlFTeFJRVUZSTEVWQlFVVXNiVUpCUmxvN1FVRkhSU3hGUVVGQkxFbEJRVWtzUlVGRFJqdEJRVXBLTEVOQlVHVXNSVUZoWmp0QlFVTkZMRVZCUVVFc1IwRkJSeXhGUVVGRkxIRkNRVVJRTzBGQlJVVXNSVUZCUVN4UlFVRlJMRVZCUVVVc1ZVRkdXanRCUVVkRkxFVkJRVUVzU1VGQlNTeEZRVU5HTzBGQlNrb3NRMEZpWlN4RlFXMUNaanRCUVVORkxFVkJRVUVzUjBGQlJ5eEZRVUZGTERCQ1FVUlFPMEZCUlVVc1JVRkJRU3hSUVVGUkxFVkJRVVVzWlVGR1dqdEJRVWRGTEVWQlFVRXNTVUZCU1N4RlFVTkdPMEZCU2tvc1EwRnVRbVVzUlVGNVFtWTdRVUZEUlN4RlFVRkJMRWRCUVVjc1JVRkJSU3h2UWtGRVVEdEJRVVZGTEVWQlFVRXNVVUZCVVN4RlFVRkZMRk5CUmxvN1FVRkhSU3hGUVVGQkxFbEJRVWtzUlVGRFJqdEJRVXBLTEVOQmVrSmxMRVZCSzBKbU8wRkJRMFVzUlVGQlFTeEhRVUZITEVWQlFVVXNiVUpCUkZBN1FVRkZSU3hGUVVGQkxGRkJRVkVzUlVGQlJTeFJRVVphTzBGQlIwVXNSVUZCUVN4SlFVRkpMRVZCUTBZN1FVRktTaXhEUVM5Q1pTeEZRWEZEWmp0QlFVTkZMRVZCUVVFc1IwRkJSeXhGUVVGRkxIRkNRVVJRTzBGQlJVVXNSVUZCUVN4UlFVRlJMRVZCUVVVc1ZVRkdXanRCUVVkRkxFVkJRVUVzU1VGQlNTeEZRVU5HTzBGQlNrb3NRMEZ5UTJVc1JVRXlRMlk3UVVGRFJTeEZRVUZCTEVkQlFVY3NSVUZCUlN4clEwRkVVRHRCUVVWRkxFVkJRVUVzVVVGQlVTeEZRVUZGTEhWQ1FVWmFPMEZCUjBVc1JVRkJRU3hKUVVGSkxFVkJRMFk3UVVGS1NpeERRVE5EWlN4RlFXbEVaanRCUVVORkxFVkJRVUVzUjBGQlJ5eEZRVUZGTERSQ1FVUlFPMEZCUlVVc1JVRkJRU3hSUVVGUkxFVkJRVVVzYVVKQlJsbzdRVUZIUlN4RlFVRkJMRWxCUVVrc1JVRkRSanRCUVVwS0xFTkJha1JsTEVOQlFXcENPMEZCZVVSQkxGRkJRVkVzUTBGQlF5eG5Ra0ZCVkN4RFFVRXdRaXhSUVVFeFFpeEZRVUZ2UXl4WlFVRk5PMEZCUTNoRExFMUJRVWtzVFVGQlRTeERRVUZETEZkQlFWQXNSMEZCY1VJc1QwRkJUeXhEUVVGRExGbEJRV3BETEVWQlFTdERPMEZCUXpkRExFbEJRVUVzVDBGQlR5eERRVUZETEZOQlFWSXNRMEZCYTBJc1RVRkJiRUlzUTBGQmVVSXNUMEZCZWtJN1FVRkRSQ3hIUVVaRUxFMUJSVTg3UVVGRFRDeEpRVUZCTEU5QlFVOHNRMEZCUXl4VFFVRlNMRU5CUVd0Q0xFZEJRV3hDTEVOQlFYTkNMRTlCUVhSQ08wRkJRMFE3UVVGRFJpeERRVTVFT3p0QlFWRkJMRTFCUVUwc1EwRkJReXhQUVVGUUxFZEJRV2xDTEZWQlFVRXNRMEZCUXl4RlFVRkpPMEZCUTNCQ0xFVkJRVUVzUTBGQlF5eERRVUZETEdOQlFVWTdRVUZEUVN4RlFVRkJMRlZCUVZVc1EwRkJReXhUUVVGWUxFTkJRWEZDTEUxQlFYSkNMRU5CUVRSQ0xFMUJRVFZDTzBGQlEwUXNRMEZJUkRzN1FVRkxRU3hSUVVGUkxFTkJRVU1zVDBGQlZDeEhRVUZ0UWl4VlFVRkJMRU5CUVVNc1JVRkJTVHRCUVVOMFFpeEZRVUZCTEVOQlFVTXNRMEZCUXl4alFVRkdPMEZCUTBFc1JVRkJRU3hWUVVGVkxFTkJRVU1zVTBGQldDeERRVUZ4UWl4TlFVRnlRaXhEUVVFMFFpeE5RVUUxUWp0QlFVTkVMRU5CU0VRN08wRkJTMEVzVlVGQlZTeERRVUZETEU5QlFWZ3NSMEZCY1VJc1dVRkJUVHRCUVVONlFpeEZRVUZCTEZWQlFWVXNRMEZCUXl4VFFVRllMRU5CUVhGQ0xFMUJRWEpDTEVOQlFUUkNMRTFCUVRWQ08wRkJRMFFzUTBGR1JEczdRVUZKUVN4VFFVRlRMRU5CUVVNc1owSkJRVllzUTBGQk1rSXNUMEZCTTBJc1JVRkJiME1zVlVGQlFTeERRVUZETEVWQlFVazdRVUZEZGtNc1RVRkJTU3hOUVVGTkxFZEJRVWNzUTBGQlF5eERRVUZETEUxQlFXWTdRVUZEUVN4TlFVRk5MRWxCUVVrc1IwRkJSeXhSUVVGUkxFTkJRVU1zYzBKQlFWUXNRMEZCWjBNc2QwSkJRV2hETEVOQlFXSTdPMEZCUTBFc1RVRkJTU3hIUVVGSExITkNRVUZQTEVsQlFWQXNRMEZCVURzN1FVRkRRU3hOUVVGSkxFMUJRVTBzUTBGQlF5eFRRVUZRTEVOQlFXbENMRkZCUVdwQ0xFTkJRVEJDTEUxQlFURkNMRU5CUVVvc1JVRkJkVU03UVVGRGNrTXNTVUZCUVN4TlFVRk5MRU5CUVVNc1UwRkJVQ3hEUVVGcFFpeE5RVUZxUWl4RFFVRjNRaXhOUVVGNFFqdEJRVU5FTEVkQlJrUXNUVUZGVHp0QlFVTk1MRWxCUVVFc1IwRkJSeXhEUVVGRExFZEJRVW9zUTBGQlVTeFZRVUZCTEVOQlFVTTdRVUZCUVN4aFFVRkpMRU5CUVVNc1EwRkJReXhUUVVGR0xFTkJRVmtzVFVGQldpeERRVUZ0UWl4TlFVRnVRaXhEUVVGS08wRkJRVUVzUzBGQlZEdEJRVU5CTEVsQlFVRXNUVUZCVFN4RFFVRkRMRk5CUVZBc1EwRkJhVUlzVFVGQmFrSXNRMEZCZDBJc1RVRkJlRUk3UVVGRFJEdEJRVU5HTEVOQlZrUTdPMEZCV1VFc1UwRkJVeXhEUVVGRExFOUJRVllzUjBGQmIwSXNWVUZCUVN4RFFVRkRMRVZCUVVrN1FVRkRka0lzUlVGQlFTeERRVUZETEVOQlFVTXNZMEZCUmp0QlFVTkJMRVZCUVVFc1UwRkJVeXhEUVVGRExGTkJRVllzUTBGQmIwSXNSMEZCY0VJc1EwRkJkMElzVFVGQmVFSTdRVUZEUVN4RlFVRkJMRk5CUVZNc1EwRkJReXhUUVVGV0xFTkJRVzlDTEVkQlFYQkNMRU5CUVhkQ0xFMUJRWGhDTzBGQlEwUXNRMEZLUkRzN1FVRk5RU3hUUVVGVExFTkJRVU1zVDBGQlZpeEhRVUZ2UWl4VlFVRkJMRU5CUVVNc1JVRkJTVHRCUVVOMlFpeEZRVUZCTEVOQlFVTXNRMEZCUXl4alFVRkdPMEZCUTBFc1JVRkJRU3hWUVVGVkxFTkJRVU1zVTBGQldDeERRVUZ4UWl4SFFVRnlRaXhEUVVGNVFpeE5RVUY2UWp0QlFVTkVMRU5CU0VRN08wRkJTMEVzU1VGQlRTeGpRVUZqTEVkQlFVY3NVMEZCYWtJc1kwRkJhVUlzUTBGQlFTeEpRVUZKTEVWQlFVazdRVUZETjBJc09FZEJSV01zU1VGQlNTeERRVUZETEVkQlJtNUNMREJIUVVseFF5eEpRVUZKTEVOQlFVTXNVVUZLTVVNc2MwUkJTMmRETEVsQlFVa3NRMEZCUXl4SlFVeHlRenRCUVZORUxFTkJWa1E3TzBGQldVRXNTVUZCU1N4aFFVRmhMRWRCUVVjc1UwRkJhRUlzWVVGQlowSXNRMEZCUVN4WlFVRlpMRVZCUVVrN1FVRkRiRU1zVFVGQlRTeFJRVUZSTEVkQlFVY3NXVUZCV1N4RFFVRkRMRWRCUVdJc1EwRkJhVUlzVlVGQlFTeFBRVUZQTzBGQlFVRXNWMEZCU1N4alFVRmpMRU5CUVVNc1QwRkJSQ3hEUVVGc1FqdEJRVUZCTEVkQlFYaENMRU5CUVdwQ08wRkJRMEVzUlVGQlFTeFJRVUZSTEVOQlFVTXNZMEZCVkN4RFFVRjNRaXhuUWtGQmVFSXNSVUZCTUVNc1UwRkJNVU1zUjBGQmMwUXNVVUZCVVN4RFFVRkRMRWxCUVZRc1EwRkJZeXhGUVVGa0xFTkJRWFJFTzBGQlEwUXNRMEZJUkRzN1FVRkxRU3hQUVVGUExFTkJRVU1zVDBGQlVpeEhRVUZyUWl4VlFVRkJMRU5CUVVNc1JVRkJTVHRCUVVOeVFpeEZRVUZCTEVOQlFVTXNRMEZCUXl4alFVRkdPMEZCUTBFc1JVRkJRU3hQUVVGUExFbEJRVWtzVFVGQldEdEJRVU5CTEVWQlFVRXNZVUZCWVN4RFFVRkRMRkZCUVZFc1EwRkJReXhMUVVGVUxFTkJRV1VzUTBGQlppeEZRVUZyUWl4UFFVRnNRaXhEUVVGRUxFTkJRV0k3UVVGRFJDeERRVXBFT3p0QlFVMUJMRTFCUVUwc1EwRkJReXhuUWtGQlVDeERRVUYzUWl4clFrRkJlRUlzUlVGQk5FTXNXVUZCVFR0QlFVTm9SQ3hOUVVGTkxGbEJRVmtzUjBGQlJ5eFRRVUZtTEZsQlFXVTdRVUZCUVR0QlFVRkJPMEZCUVVFN1FVRkJRVHRCUVVGQkxEQkNRVU5ZTEVsQlJGYzdRVUZCUVN3MFEwRkZXaXhSUVVGUkxFTkJRVU1zWlVGQlZDeERRVUY1UWl4WFFVRjZRaXhIUVVGMVF5eEhRVVl6UWl4MVFrRkxXaXhSUVVGUkxFTkJRVU1zWlVGQlZDeERRVUY1UWl4WFFVRjZRaXhIUVVGMVF5eEhRVXd6UWp0QlFVRkJPenRCUVVGQk8wRkJSMllzV1VGQlFTeFBRVUZQTEVkQlFVY3NRMEZCVmp0QlFVaGxPenRCUVVGQk8wRkJUV1lzV1VGQlFTeFBRVUZQTEVkQlFVY3NRMEZCVmp0QlFVTkJMRmxCUVVFc1RVRkJUU3hIUVVGSExFTkJRVlE3UVVGUVpUczdRVUZCUVR0QlFWVm1MRmxCUVVFc1QwRkJUeXhIUVVGSExFTkJRVlk3UVVGRFFTeFpRVUZCTEUxQlFVMHNSMEZCUnl4RFFVRlVPMEZCV0dVN08wRkJRVUU3UVVGQlFUdEJRVUZCTzBGQlFVRTdRVUZCUVR0QlFVRkJPMEZCUVVFc1IwRkJja0k3TzBGQlpVRXNSVUZCUVN4WlFVRlpPMEZCUTFvc1JVRkJRU3hoUVVGaExFTkJRVU1zVVVGQlVTeERRVUZETEV0QlFWUXNRMEZCWlN4RFFVRm1MRVZCUVd0Q0xFOUJRV3hDTEVOQlFVUXNRMEZCWWp0QlFVTkVMRU5CYkVKRUlpd2labWxzWlNJNkltZGxibVZ5WVhSbFpDNXFjeUlzSW5OdmRYSmpaVkp2YjNRaU9pSWlMQ0p6YjNWeVkyVnpRMjl1ZEdWdWRDSTZXeUlvWm5WdVkzUnBiMjRvS1h0bWRXNWpkR2x2YmlCeUtHVXNiaXgwS1h0bWRXNWpkR2x2YmlCdktHa3NaaWw3YVdZb0lXNWJhVjBwZTJsbUtDRmxXMmxkS1h0MllYSWdZejFjSW1aMWJtTjBhVzl1WENJOVBYUjVjR1Z2WmlCeVpYRjFhWEpsSmlaeVpYRjFhWEpsTzJsbUtDRm1KaVpqS1hKbGRIVnliaUJqS0drc0lUQXBPMmxtS0hVcGNtVjBkWEp1SUhVb2FTd2hNQ2s3ZG1GeUlHRTlibVYzSUVWeWNtOXlLRndpUTJGdWJtOTBJR1pwYm1RZ2JXOWtkV3hsSUNkY0lpdHBLMXdpSjF3aUtUdDBhSEp2ZHlCaExtTnZaR1U5WENKTlQwUlZURVZmVGs5VVgwWlBWVTVFWENJc1lYMTJZWElnY0QxdVcybGRQWHRsZUhCdmNuUnpPbnQ5ZlR0bFcybGRXekJkTG1OaGJHd29jQzVsZUhCdmNuUnpMR1oxYm1OMGFXOXVLSElwZTNaaGNpQnVQV1ZiYVYxYk1WMWJjbDA3Y21WMGRYSnVJRzhvYm54OGNpbDlMSEFzY0M1bGVIQnZjblJ6TEhJc1pTeHVMSFFwZlhKbGRIVnliaUJ1VzJsZExtVjRjRzl5ZEhOOVptOXlLSFpoY2lCMVBWd2lablZ1WTNScGIyNWNJajA5ZEhsd1pXOW1JSEpsY1hWcGNtVW1KbkpsY1hWcGNtVXNhVDB3TzJrOGRDNXNaVzVuZEdnN2FTc3JLVzhvZEZ0cFhTazdjbVYwZFhKdUlHOTljbVYwZFhKdUlISjlLU2dwSWl3aUx5b3FYRzRnS2lCRGIzQjVjbWxuYUhRZ0tHTXBJREl3TVRRdGNISmxjMlZ1ZEN3Z1JtRmpaV0p2YjJzc0lFbHVZeTVjYmlBcVhHNGdLaUJVYUdseklITnZkWEpqWlNCamIyUmxJR2x6SUd4cFkyVnVjMlZrSUhWdVpHVnlJSFJvWlNCTlNWUWdiR2xqWlc1elpTQm1iM1Z1WkNCcGJpQjBhR1ZjYmlBcUlFeEpRMFZPVTBVZ1ptbHNaU0JwYmlCMGFHVWdjbTl2ZENCa2FYSmxZM1J2Y25rZ2IyWWdkR2hwY3lCemIzVnlZMlVnZEhKbFpTNWNiaUFxTDF4dVhHNTJZWElnY25WdWRHbHRaU0E5SUNobWRXNWpkR2x2YmlBb1pYaHdiM0owY3lrZ2UxeHVJQ0JjSW5WelpTQnpkSEpwWTNSY0lqdGNibHh1SUNCMllYSWdUM0FnUFNCUFltcGxZM1F1Y0hKdmRHOTBlWEJsTzF4dUlDQjJZWElnYUdGelQzZHVJRDBnVDNBdWFHRnpUM2R1VUhKdmNHVnlkSGs3WEc0Z0lIWmhjaUIxYm1SbFptbHVaV1E3SUM4dklFMXZjbVVnWTI5dGNISmxjM05wWW14bElIUm9ZVzRnZG05cFpDQXdMbHh1SUNCMllYSWdKRk41YldKdmJDQTlJSFI1Y0dWdlppQlRlVzFpYjJ3Z1BUMDlJRndpWm5WdVkzUnBiMjVjSWlBL0lGTjViV0p2YkNBNklIdDlPMXh1SUNCMllYSWdhWFJsY21GMGIzSlRlVzFpYjJ3Z1BTQWtVM2x0WW05c0xtbDBaWEpoZEc5eUlIeDhJRndpUUVCcGRHVnlZWFJ2Y2x3aU8xeHVJQ0IyWVhJZ1lYTjVibU5KZEdWeVlYUnZjbE41YldKdmJDQTlJQ1JUZVcxaWIyd3VZWE41Ym1OSmRHVnlZWFJ2Y2lCOGZDQmNJa0JBWVhONWJtTkpkR1Z5WVhSdmNsd2lPMXh1SUNCMllYSWdkRzlUZEhKcGJtZFVZV2RUZVcxaWIyd2dQU0FrVTNsdFltOXNMblJ2VTNSeWFXNW5WR0ZuSUh4OElGd2lRRUIwYjFOMGNtbHVaMVJoWjF3aU8xeHVYRzRnSUdaMWJtTjBhVzl1SUhkeVlYQW9hVzV1WlhKR2Jpd2diM1YwWlhKR2Jpd2djMlZzWml3Z2RISjVURzlqYzB4cGMzUXBJSHRjYmlBZ0lDQXZMeUJKWmlCdmRYUmxja1p1SUhCeWIzWnBaR1ZrSUdGdVpDQnZkWFJsY2tadUxuQnliM1J2ZEhsd1pTQnBjeUJoSUVkbGJtVnlZWFJ2Y2l3Z2RHaGxiaUJ2ZFhSbGNrWnVMbkJ5YjNSdmRIbHdaU0JwYm5OMFlXNWpaVzltSUVkbGJtVnlZWFJ2Y2k1Y2JpQWdJQ0IyWVhJZ2NISnZkRzlIWlc1bGNtRjBiM0lnUFNCdmRYUmxja1p1SUNZbUlHOTFkR1Z5Um00dWNISnZkRzkwZVhCbElHbHVjM1JoYm1ObGIyWWdSMlZ1WlhKaGRHOXlJRDhnYjNWMFpYSkdiaUE2SUVkbGJtVnlZWFJ2Y2p0Y2JpQWdJQ0IyWVhJZ1oyVnVaWEpoZEc5eUlEMGdUMkpxWldOMExtTnlaV0YwWlNod2NtOTBiMGRsYm1WeVlYUnZjaTV3Y205MGIzUjVjR1VwTzF4dUlDQWdJSFpoY2lCamIyNTBaWGgwSUQwZ2JtVjNJRU52Ym5SbGVIUW9kSEo1VEc5amMweHBjM1FnZkh3Z1cxMHBPMXh1WEc0Z0lDQWdMeThnVkdobElDNWZhVzUyYjJ0bElHMWxkR2h2WkNCMWJtbG1hV1Z6SUhSb1pTQnBiWEJzWlcxbGJuUmhkR2x2Ym5NZ2IyWWdkR2hsSUM1dVpYaDBMRnh1SUNBZ0lDOHZJQzUwYUhKdmR5d2dZVzVrSUM1eVpYUjFjbTRnYldWMGFHOWtjeTVjYmlBZ0lDQm5aVzVsY21GMGIzSXVYMmx1ZG05clpTQTlJRzFoYTJWSmJuWnZhMlZOWlhSb2IyUW9hVzV1WlhKR2Jpd2djMlZzWml3Z1kyOXVkR1Y0ZENrN1hHNWNiaUFnSUNCeVpYUjFjbTRnWjJWdVpYSmhkRzl5TzF4dUlDQjlYRzRnSUdWNGNHOXlkSE11ZDNKaGNDQTlJSGR5WVhBN1hHNWNiaUFnTHk4Z1ZISjVMMk5oZEdOb0lHaGxiSEJsY2lCMGJ5QnRhVzVwYldsNlpTQmtaVzl3ZEdsdGFYcGhkR2x2Ym5NdUlGSmxkSFZ5Ym5NZ1lTQmpiMjF3YkdWMGFXOXVYRzRnSUM4dklISmxZMjl5WkNCc2FXdGxJR052Ym5SbGVIUXVkSEo1Ulc1MGNtbGxjMXRwWFM1amIyMXdiR1YwYVc5dUxpQlVhR2x6SUdsdWRHVnlabUZqWlNCamIzVnNaRnh1SUNBdkx5Qm9ZWFpsSUdKbFpXNGdLR0Z1WkNCM1lYTWdjSEpsZG1sdmRYTnNlU2tnWkdWemFXZHVaV1FnZEc4Z2RHRnJaU0JoSUdOc2IzTjFjbVVnZEc4Z1ltVmNiaUFnTHk4Z2FXNTJiMnRsWkNCM2FYUm9iM1YwSUdGeVozVnRaVzUwY3l3Z1luVjBJR2x1SUdGc2JDQjBhR1VnWTJGelpYTWdkMlVnWTJGeVpTQmhZbTkxZENCM1pWeHVJQ0F2THlCaGJISmxZV1I1SUdoaGRtVWdZVzRnWlhocGMzUnBibWNnYldWMGFHOWtJSGRsSUhkaGJuUWdkRzhnWTJGc2JDd2djMjhnZEdobGNtVW5jeUJ1YnlCdVpXVmtYRzRnSUM4dklIUnZJR055WldGMFpTQmhJRzVsZHlCbWRXNWpkR2x2YmlCdlltcGxZM1F1SUZkbElHTmhiaUJsZG1WdUlHZGxkQ0JoZDJGNUlIZHBkR2dnWVhOemRXMXBibWRjYmlBZ0x5OGdkR2hsSUcxbGRHaHZaQ0IwWVd0bGN5QmxlR0ZqZEd4NUlHOXVaU0JoY21kMWJXVnVkQ3dnYzJsdVkyVWdkR2hoZENCb1lYQndaVzV6SUhSdklHSmxJSFJ5ZFdWY2JpQWdMeThnYVc0Z1pYWmxjbmtnWTJGelpTd2djMjhnZDJVZ1pHOXVKM1FnYUdGMlpTQjBieUIwYjNWamFDQjBhR1VnWVhKbmRXMWxiblJ6SUc5aWFtVmpkQzRnVkdobFhHNGdJQzh2SUc5dWJIa2dZV1JrYVhScGIyNWhiQ0JoYkd4dlkyRjBhVzl1SUhKbGNYVnBjbVZrSUdseklIUm9aU0JqYjIxd2JHVjBhVzl1SUhKbFkyOXlaQ3dnZDJocFkyaGNiaUFnTHk4Z2FHRnpJR0VnYzNSaFlteGxJSE5vWVhCbElHRnVaQ0J6YnlCb2IzQmxablZzYkhrZ2MyaHZkV3hrSUdKbElHTm9aV0Z3SUhSdklHRnNiRzlqWVhSbExseHVJQ0JtZFc1amRHbHZiaUIwY25sRFlYUmphQ2htYml3Z2IySnFMQ0JoY21jcElIdGNiaUFnSUNCMGNua2dlMXh1SUNBZ0lDQWdjbVYwZFhKdUlIc2dkSGx3WlRvZ1hDSnViM0p0WVd4Y0lpd2dZWEpuT2lCbWJpNWpZV3hzS0c5aWFpd2dZWEpuS1NCOU8xeHVJQ0FnSUgwZ1kyRjBZMmdnS0dWeWNpa2dlMXh1SUNBZ0lDQWdjbVYwZFhKdUlIc2dkSGx3WlRvZ1hDSjBhSEp2ZDF3aUxDQmhjbWM2SUdWeWNpQjlPMXh1SUNBZ0lIMWNiaUFnZlZ4dVhHNGdJSFpoY2lCSFpXNVRkR0YwWlZOMWMzQmxibVJsWkZOMFlYSjBJRDBnWENKemRYTndaVzVrWldSVGRHRnlkRndpTzF4dUlDQjJZWElnUjJWdVUzUmhkR1ZUZFhOd1pXNWtaV1JaYVdWc1pDQTlJRndpYzNWemNHVnVaR1ZrV1dsbGJHUmNJanRjYmlBZ2RtRnlJRWRsYmxOMFlYUmxSWGhsWTNWMGFXNW5JRDBnWENKbGVHVmpkWFJwYm1kY0lqdGNiaUFnZG1GeUlFZGxibE4wWVhSbFEyOXRjR3hsZEdWa0lEMGdYQ0pqYjIxd2JHVjBaV1JjSWp0Y2JseHVJQ0F2THlCU1pYUjFjbTVwYm1jZ2RHaHBjeUJ2WW1wbFkzUWdabkp2YlNCMGFHVWdhVzV1WlhKR2JpQm9ZWE1nZEdobElITmhiV1VnWldabVpXTjBJR0Z6WEc0Z0lDOHZJR0p5WldGcmFXNW5JRzkxZENCdlppQjBhR1VnWkdsemNHRjBZMmdnYzNkcGRHTm9JSE4wWVhSbGJXVnVkQzVjYmlBZ2RtRnlJRU52Ym5ScGJuVmxVMlZ1ZEdsdVpXd2dQU0I3ZlR0Y2JseHVJQ0F2THlCRWRXMXRlU0JqYjI1emRISjFZM1J2Y2lCbWRXNWpkR2x2Ym5NZ2RHaGhkQ0IzWlNCMWMyVWdZWE1nZEdobElDNWpiMjV6ZEhKMVkzUnZjaUJoYm1SY2JpQWdMeThnTG1OdmJuTjBjblZqZEc5eUxuQnliM1J2ZEhsd1pTQndjbTl3WlhKMGFXVnpJR1p2Y2lCbWRXNWpkR2x2Ym5NZ2RHaGhkQ0J5WlhSMWNtNGdSMlZ1WlhKaGRHOXlYRzRnSUM4dklHOWlhbVZqZEhNdUlFWnZjaUJtZFd4c0lITndaV01nWTI5dGNHeHBZVzVqWlN3Z2VXOTFJRzFoZVNCM2FYTm9JSFJ2SUdOdmJtWnBaM1Z5WlNCNWIzVnlYRzRnSUM4dklHMXBibWxtYVdWeUlHNXZkQ0IwYnlCdFlXNW5iR1VnZEdobElHNWhiV1Z6SUc5bUlIUm9aWE5sSUhSM2J5Qm1kVzVqZEdsdmJuTXVYRzRnSUdaMWJtTjBhVzl1SUVkbGJtVnlZWFJ2Y2lncElIdDlYRzRnSUdaMWJtTjBhVzl1SUVkbGJtVnlZWFJ2Y2taMWJtTjBhVzl1S0NrZ2UzMWNiaUFnWm5WdVkzUnBiMjRnUjJWdVpYSmhkRzl5Um5WdVkzUnBiMjVRY205MGIzUjVjR1VvS1NCN2ZWeHVYRzRnSUM4dklGUm9hWE1nYVhNZ1lTQndiMng1Wm1sc2JDQm1iM0lnSlVsMFpYSmhkRzl5VUhKdmRHOTBlWEJsSlNCbWIzSWdaVzUyYVhKdmJtMWxiblJ6SUhSb1lYUmNiaUFnTHk4Z1pHOXVKM1FnYm1GMGFYWmxiSGtnYzNWd2NHOXlkQ0JwZEM1Y2JpQWdkbUZ5SUVsMFpYSmhkRzl5VUhKdmRHOTBlWEJsSUQwZ2UzMDdYRzRnSUVsMFpYSmhkRzl5VUhKdmRHOTBlWEJsVzJsMFpYSmhkRzl5VTNsdFltOXNYU0E5SUdaMWJtTjBhVzl1SUNncElIdGNiaUFnSUNCeVpYUjFjbTRnZEdocGN6dGNiaUFnZlR0Y2JseHVJQ0IyWVhJZ1oyVjBVSEp2ZEc4Z1BTQlBZbXBsWTNRdVoyVjBVSEp2ZEc5MGVYQmxUMlk3WEc0Z0lIWmhjaUJPWVhScGRtVkpkR1Z5WVhSdmNsQnliM1J2ZEhsd1pTQTlJR2RsZEZCeWIzUnZJQ1ltSUdkbGRGQnliM1J2S0dkbGRGQnliM1J2S0haaGJIVmxjeWhiWFNrcEtUdGNiaUFnYVdZZ0tFNWhkR2wyWlVsMFpYSmhkRzl5VUhKdmRHOTBlWEJsSUNZbVhHNGdJQ0FnSUNCT1lYUnBkbVZKZEdWeVlYUnZjbEJ5YjNSdmRIbHdaU0FoUFQwZ1QzQWdKaVpjYmlBZ0lDQWdJR2hoYzA5M2JpNWpZV3hzS0U1aGRHbDJaVWwwWlhKaGRHOXlVSEp2ZEc5MGVYQmxMQ0JwZEdWeVlYUnZjbE41YldKdmJDa3BJSHRjYmlBZ0lDQXZMeUJVYUdseklHVnVkbWx5YjI1dFpXNTBJR2hoY3lCaElHNWhkR2wyWlNBbFNYUmxjbUYwYjNKUWNtOTBiM1I1Y0dVbE95QjFjMlVnYVhRZ2FXNXpkR1ZoWkZ4dUlDQWdJQzh2SUc5bUlIUm9aU0J3YjJ4NVptbHNiQzVjYmlBZ0lDQkpkR1Z5WVhSdmNsQnliM1J2ZEhsd1pTQTlJRTVoZEdsMlpVbDBaWEpoZEc5eVVISnZkRzkwZVhCbE8xeHVJQ0I5WEc1Y2JpQWdkbUZ5SUVkd0lEMGdSMlZ1WlhKaGRHOXlSblZ1WTNScGIyNVFjbTkwYjNSNWNHVXVjSEp2ZEc5MGVYQmxJRDFjYmlBZ0lDQkhaVzVsY21GMGIzSXVjSEp2ZEc5MGVYQmxJRDBnVDJKcVpXTjBMbU55WldGMFpTaEpkR1Z5WVhSdmNsQnliM1J2ZEhsd1pTazdYRzRnSUVkbGJtVnlZWFJ2Y2taMWJtTjBhVzl1TG5CeWIzUnZkSGx3WlNBOUlFZHdMbU52Ym5OMGNuVmpkRzl5SUQwZ1IyVnVaWEpoZEc5eVJuVnVZM1JwYjI1UWNtOTBiM1I1Y0dVN1hHNGdJRWRsYm1WeVlYUnZja1oxYm1OMGFXOXVVSEp2ZEc5MGVYQmxMbU52Ym5OMGNuVmpkRzl5SUQwZ1IyVnVaWEpoZEc5eVJuVnVZM1JwYjI0N1hHNGdJRWRsYm1WeVlYUnZja1oxYm1OMGFXOXVVSEp2ZEc5MGVYQmxXM1J2VTNSeWFXNW5WR0ZuVTNsdFltOXNYU0E5WEc0Z0lDQWdSMlZ1WlhKaGRHOXlSblZ1WTNScGIyNHVaR2x6Y0d4aGVVNWhiV1VnUFNCY0lrZGxibVZ5WVhSdmNrWjFibU4wYVc5dVhDSTdYRzVjYmlBZ0x5OGdTR1ZzY0dWeUlHWnZjaUJrWldacGJtbHVaeUIwYUdVZ0xtNWxlSFFzSUM1MGFISnZkeXdnWVc1a0lDNXlaWFIxY200Z2JXVjBhRzlrY3lCdlppQjBhR1ZjYmlBZ0x5OGdTWFJsY21GMGIzSWdhVzUwWlhKbVlXTmxJR2x1SUhSbGNtMXpJRzltSUdFZ2MybHVaMnhsSUM1ZmFXNTJiMnRsSUcxbGRHaHZaQzVjYmlBZ1puVnVZM1JwYjI0Z1pHVm1hVzVsU1hSbGNtRjBiM0pOWlhSb2IyUnpLSEJ5YjNSdmRIbHdaU2tnZTF4dUlDQWdJRnRjSW01bGVIUmNJaXdnWENKMGFISnZkMXdpTENCY0luSmxkSFZ5Ymx3aVhTNW1iM0pGWVdOb0tHWjFibU4wYVc5dUtHMWxkR2h2WkNrZ2UxeHVJQ0FnSUNBZ2NISnZkRzkwZVhCbFcyMWxkR2h2WkYwZ1BTQm1kVzVqZEdsdmJpaGhjbWNwSUh0Y2JpQWdJQ0FnSUNBZ2NtVjBkWEp1SUhSb2FYTXVYMmx1ZG05clpTaHRaWFJvYjJRc0lHRnlaeWs3WEc0Z0lDQWdJQ0I5TzF4dUlDQWdJSDBwTzF4dUlDQjlYRzVjYmlBZ1pYaHdiM0owY3k1cGMwZGxibVZ5WVhSdmNrWjFibU4wYVc5dUlEMGdablZ1WTNScGIyNG9aMlZ1Um5WdUtTQjdYRzRnSUNBZ2RtRnlJR04wYjNJZ1BTQjBlWEJsYjJZZ1oyVnVSblZ1SUQwOVBTQmNJbVoxYm1OMGFXOXVYQ0lnSmlZZ1oyVnVSblZ1TG1OdmJuTjBjblZqZEc5eU8xeHVJQ0FnSUhKbGRIVnliaUJqZEc5eVhHNGdJQ0FnSUNBL0lHTjBiM0lnUFQwOUlFZGxibVZ5WVhSdmNrWjFibU4wYVc5dUlIeDhYRzRnSUNBZ0lDQWdJQzh2SUVadmNpQjBhR1VnYm1GMGFYWmxJRWRsYm1WeVlYUnZja1oxYm1OMGFXOXVJR052Ym5OMGNuVmpkRzl5TENCMGFHVWdZbVZ6ZENCM1pTQmpZVzVjYmlBZ0lDQWdJQ0FnTHk4Z1pHOGdhWE1nZEc4Z1kyaGxZMnNnYVhSeklDNXVZVzFsSUhCeWIzQmxjblI1TGx4dUlDQWdJQ0FnSUNBb1kzUnZjaTVrYVhOd2JHRjVUbUZ0WlNCOGZDQmpkRzl5TG01aGJXVXBJRDA5UFNCY0lrZGxibVZ5WVhSdmNrWjFibU4wYVc5dVhDSmNiaUFnSUNBZ0lEb2dabUZzYzJVN1hHNGdJSDA3WEc1Y2JpQWdaWGh3YjNKMGN5NXRZWEpySUQwZ1puVnVZM1JwYjI0b1oyVnVSblZ1S1NCN1hHNGdJQ0FnYVdZZ0tFOWlhbVZqZEM1elpYUlFjbTkwYjNSNWNHVlBaaWtnZTF4dUlDQWdJQ0FnVDJKcVpXTjBMbk5sZEZCeWIzUnZkSGx3WlU5bUtHZGxia1oxYml3Z1IyVnVaWEpoZEc5eVJuVnVZM1JwYjI1UWNtOTBiM1I1Y0dVcE8xeHVJQ0FnSUgwZ1pXeHpaU0I3WEc0Z0lDQWdJQ0JuWlc1R2RXNHVYMTl3Y205MGIxOWZJRDBnUjJWdVpYSmhkRzl5Um5WdVkzUnBiMjVRY205MGIzUjVjR1U3WEc0Z0lDQWdJQ0JwWmlBb0lTaDBiMU4wY21sdVoxUmhaMU41YldKdmJDQnBiaUJuWlc1R2RXNHBLU0I3WEc0Z0lDQWdJQ0FnSUdkbGJrWjFibHQwYjFOMGNtbHVaMVJoWjFONWJXSnZiRjBnUFNCY0lrZGxibVZ5WVhSdmNrWjFibU4wYVc5dVhDSTdYRzRnSUNBZ0lDQjlYRzRnSUNBZ2ZWeHVJQ0FnSUdkbGJrWjFiaTV3Y205MGIzUjVjR1VnUFNCUFltcGxZM1F1WTNKbFlYUmxLRWR3S1R0Y2JpQWdJQ0J5WlhSMWNtNGdaMlZ1Um5WdU8xeHVJQ0I5TzF4dVhHNGdJQzh2SUZkcGRHaHBiaUIwYUdVZ1ltOWtlU0J2WmlCaGJua2dZWE41Ym1NZ1puVnVZM1JwYjI0c0lHQmhkMkZwZENCNFlDQnBjeUIwY21GdWMyWnZjbTFsWkNCMGIxeHVJQ0F2THlCZ2VXbGxiR1FnY21WblpXNWxjbUYwYjNKU2RXNTBhVzFsTG1GM2NtRndLSGdwWUN3Z2MyOGdkR2hoZENCMGFHVWdjblZ1ZEdsdFpTQmpZVzRnZEdWemRGeHVJQ0F2THlCZ2FHRnpUM2R1TG1OaGJHd29kbUZzZFdVc0lGd2lYMTloZDJGcGRGd2lLV0FnZEc4Z1pHVjBaWEp0YVc1bElHbG1JSFJvWlNCNWFXVnNaR1ZrSUhaaGJIVmxJR2x6WEc0Z0lDOHZJRzFsWVc1MElIUnZJR0psSUdGM1lXbDBaV1F1WEc0Z0lHVjRjRzl5ZEhNdVlYZHlZWEFnUFNCbWRXNWpkR2x2YmloaGNtY3BJSHRjYmlBZ0lDQnlaWFIxY200Z2V5QmZYMkYzWVdsME9pQmhjbWNnZlR0Y2JpQWdmVHRjYmx4dUlDQm1kVzVqZEdsdmJpQkJjM2x1WTBsMFpYSmhkRzl5S0dkbGJtVnlZWFJ2Y2lrZ2UxeHVJQ0FnSUdaMWJtTjBhVzl1SUdsdWRtOXJaU2h0WlhSb2IyUXNJR0Z5Wnl3Z2NtVnpiMngyWlN3Z2NtVnFaV04wS1NCN1hHNGdJQ0FnSUNCMllYSWdjbVZqYjNKa0lEMGdkSEo1UTJGMFkyZ29aMlZ1WlhKaGRHOXlXMjFsZEdodlpGMHNJR2RsYm1WeVlYUnZjaXdnWVhKbktUdGNiaUFnSUNBZ0lHbG1JQ2h5WldOdmNtUXVkSGx3WlNBOVBUMGdYQ0owYUhKdmQxd2lLU0I3WEc0Z0lDQWdJQ0FnSUhKbGFtVmpkQ2h5WldOdmNtUXVZWEpuS1R0Y2JpQWdJQ0FnSUgwZ1pXeHpaU0I3WEc0Z0lDQWdJQ0FnSUhaaGNpQnlaWE4xYkhRZ1BTQnlaV052Y21RdVlYSm5PMXh1SUNBZ0lDQWdJQ0IyWVhJZ2RtRnNkV1VnUFNCeVpYTjFiSFF1ZG1Gc2RXVTdYRzRnSUNBZ0lDQWdJR2xtSUNoMllXeDFaU0FtSmx4dUlDQWdJQ0FnSUNBZ0lDQWdkSGx3Wlc5bUlIWmhiSFZsSUQwOVBTQmNJbTlpYW1WamRGd2lJQ1ltWEc0Z0lDQWdJQ0FnSUNBZ0lDQm9ZWE5QZDI0dVkyRnNiQ2gyWVd4MVpTd2dYQ0pmWDJGM1lXbDBYQ0lwS1NCN1hHNGdJQ0FnSUNBZ0lDQWdjbVYwZFhKdUlGQnliMjFwYzJVdWNtVnpiMngyWlNoMllXeDFaUzVmWDJGM1lXbDBLUzUwYUdWdUtHWjFibU4wYVc5dUtIWmhiSFZsS1NCN1hHNGdJQ0FnSUNBZ0lDQWdJQ0JwYm5admEyVW9YQ0p1WlhoMFhDSXNJSFpoYkhWbExDQnlaWE52YkhabExDQnlaV3BsWTNRcE8xeHVJQ0FnSUNBZ0lDQWdJSDBzSUdaMWJtTjBhVzl1S0dWeWNpa2dlMXh1SUNBZ0lDQWdJQ0FnSUNBZ2FXNTJiMnRsS0Z3aWRHaHliM2RjSWl3Z1pYSnlMQ0J5WlhOdmJIWmxMQ0J5WldwbFkzUXBPMXh1SUNBZ0lDQWdJQ0FnSUgwcE8xeHVJQ0FnSUNBZ0lDQjlYRzVjYmlBZ0lDQWdJQ0FnY21WMGRYSnVJRkJ5YjIxcGMyVXVjbVZ6YjJ4MlpTaDJZV3gxWlNrdWRHaGxiaWhtZFc1amRHbHZiaWgxYm5keVlYQndaV1FwSUh0Y2JpQWdJQ0FnSUNBZ0lDQXZMeUJYYUdWdUlHRWdlV2xsYkdSbFpDQlFjbTl0YVhObElHbHpJSEpsYzI5c2RtVmtMQ0JwZEhNZ1ptbHVZV3dnZG1Gc2RXVWdZbVZqYjIxbGMxeHVJQ0FnSUNBZ0lDQWdJQzh2SUhSb1pTQXVkbUZzZFdVZ2IyWWdkR2hsSUZCeWIyMXBjMlU4ZTNaaGJIVmxMR1J2Ym1WOVBpQnlaWE4xYkhRZ1ptOXlJSFJvWlZ4dUlDQWdJQ0FnSUNBZ0lDOHZJR04xY25KbGJuUWdhWFJsY21GMGFXOXVMbHh1SUNBZ0lDQWdJQ0FnSUhKbGMzVnNkQzUyWVd4MVpTQTlJSFZ1ZDNKaGNIQmxaRHRjYmlBZ0lDQWdJQ0FnSUNCeVpYTnZiSFpsS0hKbGMzVnNkQ2s3WEc0Z0lDQWdJQ0FnSUgwc0lHWjFibU4wYVc5dUtHVnljbTl5S1NCN1hHNGdJQ0FnSUNBZ0lDQWdMeThnU1dZZ1lTQnlaV3BsWTNSbFpDQlFjbTl0YVhObElIZGhjeUI1YVdWc1pHVmtMQ0IwYUhKdmR5QjBhR1VnY21WcVpXTjBhVzl1SUdKaFkydGNiaUFnSUNBZ0lDQWdJQ0F2THlCcGJuUnZJSFJvWlNCaGMzbHVZeUJuWlc1bGNtRjBiM0lnWm5WdVkzUnBiMjRnYzI4Z2FYUWdZMkZ1SUdKbElHaGhibVJzWldRZ2RHaGxjbVV1WEc0Z0lDQWdJQ0FnSUNBZ2NtVjBkWEp1SUdsdWRtOXJaU2hjSW5Sb2NtOTNYQ0lzSUdWeWNtOXlMQ0J5WlhOdmJIWmxMQ0J5WldwbFkzUXBPMXh1SUNBZ0lDQWdJQ0I5S1R0Y2JpQWdJQ0FnSUgxY2JpQWdJQ0I5WEc1Y2JpQWdJQ0IyWVhJZ2NISmxkbWx2ZFhOUWNtOXRhWE5sTzF4dVhHNGdJQ0FnWm5WdVkzUnBiMjRnWlc1eGRXVjFaU2h0WlhSb2IyUXNJR0Z5WnlrZ2UxeHVJQ0FnSUNBZ1puVnVZM1JwYjI0Z1kyRnNiRWx1ZG05clpWZHBkR2hOWlhSb2IyUkJibVJCY21jb0tTQjdYRzRnSUNBZ0lDQWdJSEpsZEhWeWJpQnVaWGNnVUhKdmJXbHpaU2htZFc1amRHbHZiaWh5WlhOdmJIWmxMQ0J5WldwbFkzUXBJSHRjYmlBZ0lDQWdJQ0FnSUNCcGJuWnZhMlVvYldWMGFHOWtMQ0JoY21jc0lISmxjMjlzZG1Vc0lISmxhbVZqZENrN1hHNGdJQ0FnSUNBZ0lIMHBPMXh1SUNBZ0lDQWdmVnh1WEc0Z0lDQWdJQ0J5WlhSMWNtNGdjSEpsZG1sdmRYTlFjbTl0YVhObElEMWNiaUFnSUNBZ0lDQWdMeThnU1dZZ1pXNXhkV1YxWlNCb1lYTWdZbVZsYmlCallXeHNaV1FnWW1WbWIzSmxMQ0IwYUdWdUlIZGxJSGRoYm5RZ2RHOGdkMkZwZENCMWJuUnBiRnh1SUNBZ0lDQWdJQ0F2THlCaGJHd2djSEpsZG1sdmRYTWdVSEp2YldselpYTWdhR0YyWlNCaVpXVnVJSEpsYzI5c2RtVmtJR0psWm05eVpTQmpZV3hzYVc1bklHbHVkbTlyWlN4Y2JpQWdJQ0FnSUNBZ0x5OGdjMjhnZEdoaGRDQnlaWE4xYkhSeklHRnlaU0JoYkhkaGVYTWdaR1ZzYVhabGNtVmtJR2x1SUhSb1pTQmpiM0p5WldOMElHOXlaR1Z5TGlCSlpseHVJQ0FnSUNBZ0lDQXZMeUJsYm5GMVpYVmxJR2hoY3lCdWIzUWdZbVZsYmlCallXeHNaV1FnWW1WbWIzSmxMQ0IwYUdWdUlHbDBJR2x6SUdsdGNHOXlkR0Z1ZENCMGIxeHVJQ0FnSUNBZ0lDQXZMeUJqWVd4c0lHbHVkbTlyWlNCcGJXMWxaR2xoZEdWc2VTd2dkMmwwYUc5MWRDQjNZV2wwYVc1bklHOXVJR0VnWTJGc2JHSmhZMnNnZEc4Z1ptbHlaU3hjYmlBZ0lDQWdJQ0FnTHk4Z2MyOGdkR2hoZENCMGFHVWdZWE41Ym1NZ1oyVnVaWEpoZEc5eUlHWjFibU4wYVc5dUlHaGhjeUIwYUdVZ2IzQndiM0owZFc1cGRIa2dkRzhnWkc5Y2JpQWdJQ0FnSUNBZ0x5OGdZVzU1SUc1bFkyVnpjMkZ5ZVNCelpYUjFjQ0JwYmlCaElIQnlaV1JwWTNSaFlteGxJSGRoZVM0Z1ZHaHBjeUJ3Y21Wa2FXTjBZV0pwYkdsMGVWeHVJQ0FnSUNBZ0lDQXZMeUJwY3lCM2FIa2dkR2hsSUZCeWIyMXBjMlVnWTI5dWMzUnlkV04wYjNJZ2MzbHVZMmh5YjI1dmRYTnNlU0JwYm5admEyVnpJR2wwYzF4dUlDQWdJQ0FnSUNBdkx5QmxlR1ZqZFhSdmNpQmpZV3hzWW1GamF5d2dZVzVrSUhkb2VTQmhjM2x1WXlCbWRXNWpkR2x2Ym5NZ2MzbHVZMmh5YjI1dmRYTnNlVnh1SUNBZ0lDQWdJQ0F2THlCbGVHVmpkWFJsSUdOdlpHVWdZbVZtYjNKbElIUm9aU0JtYVhKemRDQmhkMkZwZEM0Z1UybHVZMlVnZDJVZ2FXMXdiR1Z0Wlc1MElITnBiWEJzWlZ4dUlDQWdJQ0FnSUNBdkx5QmhjM2x1WXlCbWRXNWpkR2x2Ym5NZ2FXNGdkR1Z5YlhNZ2IyWWdZWE41Ym1NZ1oyVnVaWEpoZEc5eWN5d2dhWFFnYVhNZ1pYTndaV05wWVd4c2VWeHVJQ0FnSUNBZ0lDQXZMeUJwYlhCdmNuUmhiblFnZEc4Z1oyVjBJSFJvYVhNZ2NtbG5hSFFzSUdWMlpXNGdkR2h2ZFdkb0lHbDBJSEpsY1hWcGNtVnpJR05oY21VdVhHNGdJQ0FnSUNBZ0lIQnlaWFpwYjNWelVISnZiV2x6WlNBL0lIQnlaWFpwYjNWelVISnZiV2x6WlM1MGFHVnVLRnh1SUNBZ0lDQWdJQ0FnSUdOaGJHeEpiblp2YTJWWGFYUm9UV1YwYUc5a1FXNWtRWEpuTEZ4dUlDQWdJQ0FnSUNBZ0lDOHZJRUYyYjJsa0lIQnliM0JoWjJGMGFXNW5JR1poYVd4MWNtVnpJSFJ2SUZCeWIyMXBjMlZ6SUhKbGRIVnlibVZrSUdKNUlHeGhkR1Z5WEc0Z0lDQWdJQ0FnSUNBZ0x5OGdhVzUyYjJOaGRHbHZibk1nYjJZZ2RHaGxJR2wwWlhKaGRHOXlMbHh1SUNBZ0lDQWdJQ0FnSUdOaGJHeEpiblp2YTJWWGFYUm9UV1YwYUc5a1FXNWtRWEpuWEc0Z0lDQWdJQ0FnSUNrZ09pQmpZV3hzU1c1MmIydGxWMmwwYUUxbGRHaHZaRUZ1WkVGeVp5Z3BPMXh1SUNBZ0lIMWNibHh1SUNBZ0lDOHZJRVJsWm1sdVpTQjBhR1VnZFc1cFptbGxaQ0JvWld4d1pYSWdiV1YwYUc5a0lIUm9ZWFFnYVhNZ2RYTmxaQ0IwYnlCcGJYQnNaVzFsYm5RZ0xtNWxlSFFzWEc0Z0lDQWdMeThnTG5Sb2NtOTNMQ0JoYm1RZ0xuSmxkSFZ5YmlBb2MyVmxJR1JsWm1sdVpVbDBaWEpoZEc5eVRXVjBhRzlrY3lrdVhHNGdJQ0FnZEdocGN5NWZhVzUyYjJ0bElEMGdaVzV4ZFdWMVpUdGNiaUFnZlZ4dVhHNGdJR1JsWm1sdVpVbDBaWEpoZEc5eVRXVjBhRzlrY3loQmMzbHVZMGwwWlhKaGRHOXlMbkJ5YjNSdmRIbHdaU2s3WEc0Z0lFRnplVzVqU1hSbGNtRjBiM0l1Y0hKdmRHOTBlWEJsVzJGemVXNWpTWFJsY21GMGIzSlRlVzFpYjJ4ZElEMGdablZ1WTNScGIyNGdLQ2tnZTF4dUlDQWdJSEpsZEhWeWJpQjBhR2x6TzF4dUlDQjlPMXh1SUNCbGVIQnZjblJ6TGtGemVXNWpTWFJsY21GMGIzSWdQU0JCYzNsdVkwbDBaWEpoZEc5eU8xeHVYRzRnSUM4dklFNXZkR1VnZEdoaGRDQnphVzF3YkdVZ1lYTjVibU1nWm5WdVkzUnBiMjV6SUdGeVpTQnBiWEJzWlcxbGJuUmxaQ0J2YmlCMGIzQWdiMlpjYmlBZ0x5OGdRWE41Ym1OSmRHVnlZWFJ2Y2lCdlltcGxZM1J6T3lCMGFHVjVJR3AxYzNRZ2NtVjBkWEp1SUdFZ1VISnZiV2x6WlNCbWIzSWdkR2hsSUhaaGJIVmxJRzltWEc0Z0lDOHZJSFJvWlNCbWFXNWhiQ0J5WlhOMWJIUWdjSEp2WkhWalpXUWdZbmtnZEdobElHbDBaWEpoZEc5eUxseHVJQ0JsZUhCdmNuUnpMbUZ6ZVc1aklEMGdablZ1WTNScGIyNG9hVzV1WlhKR2Jpd2diM1YwWlhKR2Jpd2djMlZzWml3Z2RISjVURzlqYzB4cGMzUXBJSHRjYmlBZ0lDQjJZWElnYVhSbGNpQTlJRzVsZHlCQmMzbHVZMGwwWlhKaGRHOXlLRnh1SUNBZ0lDQWdkM0poY0NocGJtNWxja1p1TENCdmRYUmxja1p1TENCelpXeG1MQ0IwY25sTWIyTnpUR2x6ZENsY2JpQWdJQ0FwTzF4dVhHNGdJQ0FnY21WMGRYSnVJR1Y0Y0c5eWRITXVhWE5IWlc1bGNtRjBiM0pHZFc1amRHbHZiaWh2ZFhSbGNrWnVLVnh1SUNBZ0lDQWdQeUJwZEdWeUlDOHZJRWxtSUc5MWRHVnlSbTRnYVhNZ1lTQm5aVzVsY21GMGIzSXNJSEpsZEhWeWJpQjBhR1VnWm5Wc2JDQnBkR1Z5WVhSdmNpNWNiaUFnSUNBZ0lEb2dhWFJsY2k1dVpYaDBLQ2t1ZEdobGJpaG1kVzVqZEdsdmJpaHlaWE4xYkhRcElIdGNiaUFnSUNBZ0lDQWdJQ0J5WlhSMWNtNGdjbVZ6ZFd4MExtUnZibVVnUHlCeVpYTjFiSFF1ZG1Gc2RXVWdPaUJwZEdWeUxtNWxlSFFvS1R0Y2JpQWdJQ0FnSUNBZ2ZTazdYRzRnSUgwN1hHNWNiaUFnWm5WdVkzUnBiMjRnYldGclpVbHVkbTlyWlUxbGRHaHZaQ2hwYm01bGNrWnVMQ0J6Wld4bUxDQmpiMjUwWlhoMEtTQjdYRzRnSUNBZ2RtRnlJSE4wWVhSbElEMGdSMlZ1VTNSaGRHVlRkWE53Wlc1a1pXUlRkR0Z5ZER0Y2JseHVJQ0FnSUhKbGRIVnliaUJtZFc1amRHbHZiaUJwYm5admEyVW9iV1YwYUc5a0xDQmhjbWNwSUh0Y2JpQWdJQ0FnSUdsbUlDaHpkR0YwWlNBOVBUMGdSMlZ1VTNSaGRHVkZlR1ZqZFhScGJtY3BJSHRjYmlBZ0lDQWdJQ0FnZEdoeWIzY2dibVYzSUVWeWNtOXlLRndpUjJWdVpYSmhkRzl5SUdseklHRnNjbVZoWkhrZ2NuVnVibWx1WjF3aUtUdGNiaUFnSUNBZ0lIMWNibHh1SUNBZ0lDQWdhV1lnS0hOMFlYUmxJRDA5UFNCSFpXNVRkR0YwWlVOdmJYQnNaWFJsWkNrZ2UxeHVJQ0FnSUNBZ0lDQnBaaUFvYldWMGFHOWtJRDA5UFNCY0luUm9jbTkzWENJcElIdGNiaUFnSUNBZ0lDQWdJQ0IwYUhKdmR5QmhjbWM3WEc0Z0lDQWdJQ0FnSUgxY2JseHVJQ0FnSUNBZ0lDQXZMeUJDWlNCbWIzSm5hWFpwYm1jc0lIQmxjaUF5TlM0ekxqTXVNeTR6SUc5bUlIUm9aU0J6Y0dWak9seHVJQ0FnSUNBZ0lDQXZMeUJvZEhSd2N6b3ZMM0JsYjNCc1pTNXRiM3BwYkd4aExtOXlaeTkrYW05eVpXNWtiM0ptWmk5bGN6WXRaSEpoWm5RdWFIUnRiQ056WldNdFoyVnVaWEpoZEc5eWNtVnpkVzFsWEc0Z0lDQWdJQ0FnSUhKbGRIVnliaUJrYjI1bFVtVnpkV3gwS0NrN1hHNGdJQ0FnSUNCOVhHNWNiaUFnSUNBZ0lHTnZiblJsZUhRdWJXVjBhRzlrSUQwZ2JXVjBhRzlrTzF4dUlDQWdJQ0FnWTI5dWRHVjRkQzVoY21jZ1BTQmhjbWM3WEc1Y2JpQWdJQ0FnSUhkb2FXeGxJQ2gwY25WbEtTQjdYRzRnSUNBZ0lDQWdJSFpoY2lCa1pXeGxaMkYwWlNBOUlHTnZiblJsZUhRdVpHVnNaV2RoZEdVN1hHNGdJQ0FnSUNBZ0lHbG1JQ2hrWld4bFoyRjBaU2tnZTF4dUlDQWdJQ0FnSUNBZ0lIWmhjaUJrWld4bFoyRjBaVkpsYzNWc2RDQTlJRzFoZVdKbFNXNTJiMnRsUkdWc1pXZGhkR1VvWkdWc1pXZGhkR1VzSUdOdmJuUmxlSFFwTzF4dUlDQWdJQ0FnSUNBZ0lHbG1JQ2hrWld4bFoyRjBaVkpsYzNWc2RDa2dlMXh1SUNBZ0lDQWdJQ0FnSUNBZ2FXWWdLR1JsYkdWbllYUmxVbVZ6ZFd4MElEMDlQU0JEYjI1MGFXNTFaVk5sYm5ScGJtVnNLU0JqYjI1MGFXNTFaVHRjYmlBZ0lDQWdJQ0FnSUNBZ0lISmxkSFZ5YmlCa1pXeGxaMkYwWlZKbGMzVnNkRHRjYmlBZ0lDQWdJQ0FnSUNCOVhHNGdJQ0FnSUNBZ0lIMWNibHh1SUNBZ0lDQWdJQ0JwWmlBb1kyOXVkR1Y0ZEM1dFpYUm9iMlFnUFQwOUlGd2libVY0ZEZ3aUtTQjdYRzRnSUNBZ0lDQWdJQ0FnTHk4Z1UyVjBkR2x1WnlCamIyNTBaWGgwTGw5elpXNTBJR1p2Y2lCc1pXZGhZM2tnYzNWd2NHOXlkQ0J2WmlCQ1lXSmxiQ2R6WEc0Z0lDQWdJQ0FnSUNBZ0x5OGdablZ1WTNScGIyNHVjMlZ1ZENCcGJYQnNaVzFsYm5SaGRHbHZiaTVjYmlBZ0lDQWdJQ0FnSUNCamIyNTBaWGgwTG5ObGJuUWdQU0JqYjI1MFpYaDBMbDl6Wlc1MElEMGdZMjl1ZEdWNGRDNWhjbWM3WEc1Y2JpQWdJQ0FnSUNBZ2ZTQmxiSE5sSUdsbUlDaGpiMjUwWlhoMExtMWxkR2h2WkNBOVBUMGdYQ0owYUhKdmQxd2lLU0I3WEc0Z0lDQWdJQ0FnSUNBZ2FXWWdLSE4wWVhSbElEMDlQU0JIWlc1VGRHRjBaVk4xYzNCbGJtUmxaRk4wWVhKMEtTQjdYRzRnSUNBZ0lDQWdJQ0FnSUNCemRHRjBaU0E5SUVkbGJsTjBZWFJsUTI5dGNHeGxkR1ZrTzF4dUlDQWdJQ0FnSUNBZ0lDQWdkR2h5YjNjZ1kyOXVkR1Y0ZEM1aGNtYzdYRzRnSUNBZ0lDQWdJQ0FnZlZ4dVhHNGdJQ0FnSUNBZ0lDQWdZMjl1ZEdWNGRDNWthWE53WVhSamFFVjRZMlZ3ZEdsdmJpaGpiMjUwWlhoMExtRnlaeWs3WEc1Y2JpQWdJQ0FnSUNBZ2ZTQmxiSE5sSUdsbUlDaGpiMjUwWlhoMExtMWxkR2h2WkNBOVBUMGdYQ0p5WlhSMWNtNWNJaWtnZTF4dUlDQWdJQ0FnSUNBZ0lHTnZiblJsZUhRdVlXSnlkWEIwS0Z3aWNtVjBkWEp1WENJc0lHTnZiblJsZUhRdVlYSm5LVHRjYmlBZ0lDQWdJQ0FnZlZ4dVhHNGdJQ0FnSUNBZ0lITjBZWFJsSUQwZ1IyVnVVM1JoZEdWRmVHVmpkWFJwYm1jN1hHNWNiaUFnSUNBZ0lDQWdkbUZ5SUhKbFkyOXlaQ0E5SUhSeWVVTmhkR05vS0dsdWJtVnlSbTRzSUhObGJHWXNJR052Ym5SbGVIUXBPMXh1SUNBZ0lDQWdJQ0JwWmlBb2NtVmpiM0prTG5SNWNHVWdQVDA5SUZ3aWJtOXliV0ZzWENJcElIdGNiaUFnSUNBZ0lDQWdJQ0F2THlCSlppQmhiaUJsZUdObGNIUnBiMjRnYVhNZ2RHaHliM2R1SUdaeWIyMGdhVzV1WlhKR2Jpd2dkMlVnYkdWaGRtVWdjM1JoZEdVZ1BUMDlYRzRnSUNBZ0lDQWdJQ0FnTHk4Z1IyVnVVM1JoZEdWRmVHVmpkWFJwYm1jZ1lXNWtJR3h2YjNBZ1ltRmpheUJtYjNJZ1lXNXZkR2hsY2lCcGJuWnZZMkYwYVc5dUxseHVJQ0FnSUNBZ0lDQWdJSE4wWVhSbElEMGdZMjl1ZEdWNGRDNWtiMjVsWEc0Z0lDQWdJQ0FnSUNBZ0lDQS9JRWRsYmxOMFlYUmxRMjl0Y0d4bGRHVmtYRzRnSUNBZ0lDQWdJQ0FnSUNBNklFZGxibE4wWVhSbFUzVnpjR1Z1WkdWa1dXbGxiR1E3WEc1Y2JpQWdJQ0FnSUNBZ0lDQnBaaUFvY21WamIzSmtMbUZ5WnlBOVBUMGdRMjl1ZEdsdWRXVlRaVzUwYVc1bGJDa2dlMXh1SUNBZ0lDQWdJQ0FnSUNBZ1kyOXVkR2x1ZFdVN1hHNGdJQ0FnSUNBZ0lDQWdmVnh1WEc0Z0lDQWdJQ0FnSUNBZ2NtVjBkWEp1SUh0Y2JpQWdJQ0FnSUNBZ0lDQWdJSFpoYkhWbE9pQnlaV052Y21RdVlYSm5MRnh1SUNBZ0lDQWdJQ0FnSUNBZ1pHOXVaVG9nWTI5dWRHVjRkQzVrYjI1bFhHNGdJQ0FnSUNBZ0lDQWdmVHRjYmx4dUlDQWdJQ0FnSUNCOUlHVnNjMlVnYVdZZ0tISmxZMjl5WkM1MGVYQmxJRDA5UFNCY0luUm9jbTkzWENJcElIdGNiaUFnSUNBZ0lDQWdJQ0J6ZEdGMFpTQTlJRWRsYmxOMFlYUmxRMjl0Y0d4bGRHVmtPMXh1SUNBZ0lDQWdJQ0FnSUM4dklFUnBjM0JoZEdOb0lIUm9aU0JsZUdObGNIUnBiMjRnWW5rZ2JHOXZjR2x1WnlCaVlXTnJJR0Z5YjNWdVpDQjBieUIwYUdWY2JpQWdJQ0FnSUNBZ0lDQXZMeUJqYjI1MFpYaDBMbVJwYzNCaGRHTm9SWGhqWlhCMGFXOXVLR052Ym5SbGVIUXVZWEpuS1NCallXeHNJR0ZpYjNabExseHVJQ0FnSUNBZ0lDQWdJR052Ym5SbGVIUXViV1YwYUc5a0lEMGdYQ0owYUhKdmQxd2lPMXh1SUNBZ0lDQWdJQ0FnSUdOdmJuUmxlSFF1WVhKbklEMGdjbVZqYjNKa0xtRnlaenRjYmlBZ0lDQWdJQ0FnZlZ4dUlDQWdJQ0FnZlZ4dUlDQWdJSDA3WEc0Z0lIMWNibHh1SUNBdkx5QkRZV3hzSUdSbGJHVm5ZWFJsTG1sMFpYSmhkRzl5VzJOdmJuUmxlSFF1YldWMGFHOWtYU2hqYjI1MFpYaDBMbUZ5WnlrZ1lXNWtJR2hoYm1Sc1pTQjBhR1ZjYmlBZ0x5OGdjbVZ6ZFd4MExDQmxhWFJvWlhJZ1lua2djbVYwZFhKdWFXNW5JR0VnZXlCMllXeDFaU3dnWkc5dVpTQjlJSEpsYzNWc2RDQm1jbTl0SUhSb1pWeHVJQ0F2THlCa1pXeGxaMkYwWlNCcGRHVnlZWFJ2Y2l3Z2IzSWdZbmtnYlc5a2FXWjVhVzVuSUdOdmJuUmxlSFF1YldWMGFHOWtJR0Z1WkNCamIyNTBaWGgwTG1GeVp5eGNiaUFnTHk4Z2MyVjBkR2x1WnlCamIyNTBaWGgwTG1SbGJHVm5ZWFJsSUhSdklHNTFiR3dzSUdGdVpDQnlaWFIxY201cGJtY2dkR2hsSUVOdmJuUnBiblZsVTJWdWRHbHVaV3d1WEc0Z0lHWjFibU4wYVc5dUlHMWhlV0psU1c1MmIydGxSR1ZzWldkaGRHVW9aR1ZzWldkaGRHVXNJR052Ym5SbGVIUXBJSHRjYmlBZ0lDQjJZWElnYldWMGFHOWtJRDBnWkdWc1pXZGhkR1V1YVhSbGNtRjBiM0piWTI5dWRHVjRkQzV0WlhSb2IyUmRPMXh1SUNBZ0lHbG1JQ2h0WlhSb2IyUWdQVDA5SUhWdVpHVm1hVzVsWkNrZ2UxeHVJQ0FnSUNBZ0x5OGdRU0F1ZEdoeWIzY2diM0lnTG5KbGRIVnliaUIzYUdWdUlIUm9aU0JrWld4bFoyRjBaU0JwZEdWeVlYUnZjaUJvWVhNZ2JtOGdMblJvY205M1hHNGdJQ0FnSUNBdkx5QnRaWFJvYjJRZ1lXeDNZWGx6SUhSbGNtMXBibUYwWlhNZ2RHaGxJSGxwWld4a0tpQnNiMjl3TGx4dUlDQWdJQ0FnWTI5dWRHVjRkQzVrWld4bFoyRjBaU0E5SUc1MWJHdzdYRzVjYmlBZ0lDQWdJR2xtSUNoamIyNTBaWGgwTG0xbGRHaHZaQ0E5UFQwZ1hDSjBhSEp2ZDF3aUtTQjdYRzRnSUNBZ0lDQWdJQzh2SUU1dmRHVTZJRnRjSW5KbGRIVnlibHdpWFNCdGRYTjBJR0psSUhWelpXUWdabTl5SUVWVE15QndZWEp6YVc1bklHTnZiWEJoZEdsaWFXeHBkSGt1WEc0Z0lDQWdJQ0FnSUdsbUlDaGtaV3hsWjJGMFpTNXBkR1Z5WVhSdmNsdGNJbkpsZEhWeWJsd2lYU2tnZTF4dUlDQWdJQ0FnSUNBZ0lDOHZJRWxtSUhSb1pTQmtaV3hsWjJGMFpTQnBkR1Z5WVhSdmNpQm9ZWE1nWVNCeVpYUjFjbTRnYldWMGFHOWtMQ0JuYVhabElHbDBJR0ZjYmlBZ0lDQWdJQ0FnSUNBdkx5QmphR0Z1WTJVZ2RHOGdZMnhsWVc0Z2RYQXVYRzRnSUNBZ0lDQWdJQ0FnWTI5dWRHVjRkQzV0WlhSb2IyUWdQU0JjSW5KbGRIVnlibHdpTzF4dUlDQWdJQ0FnSUNBZ0lHTnZiblJsZUhRdVlYSm5JRDBnZFc1a1pXWnBibVZrTzF4dUlDQWdJQ0FnSUNBZ0lHMWhlV0psU1c1MmIydGxSR1ZzWldkaGRHVW9aR1ZzWldkaGRHVXNJR052Ym5SbGVIUXBPMXh1WEc0Z0lDQWdJQ0FnSUNBZ2FXWWdLR052Ym5SbGVIUXViV1YwYUc5a0lEMDlQU0JjSW5Sb2NtOTNYQ0lwSUh0Y2JpQWdJQ0FnSUNBZ0lDQWdJQzh2SUVsbUlHMWhlV0psU1c1MmIydGxSR1ZzWldkaGRHVW9ZMjl1ZEdWNGRDa2dZMmhoYm1kbFpDQmpiMjUwWlhoMExtMWxkR2h2WkNCbWNtOXRYRzRnSUNBZ0lDQWdJQ0FnSUNBdkx5QmNJbkpsZEhWeWJsd2lJSFJ2SUZ3aWRHaHliM2RjSWl3Z2JHVjBJSFJvWVhRZ2IzWmxjbkpwWkdVZ2RHaGxJRlI1Y0dWRmNuSnZjaUJpWld4dmR5NWNiaUFnSUNBZ0lDQWdJQ0FnSUhKbGRIVnliaUJEYjI1MGFXNTFaVk5sYm5ScGJtVnNPMXh1SUNBZ0lDQWdJQ0FnSUgxY2JpQWdJQ0FnSUNBZ2ZWeHVYRzRnSUNBZ0lDQWdJR052Ym5SbGVIUXViV1YwYUc5a0lEMGdYQ0owYUhKdmQxd2lPMXh1SUNBZ0lDQWdJQ0JqYjI1MFpYaDBMbUZ5WnlBOUlHNWxkeUJVZVhCbFJYSnliM0lvWEc0Z0lDQWdJQ0FnSUNBZ1hDSlVhR1VnYVhSbGNtRjBiM0lnWkc5bGN5QnViM1FnY0hKdmRtbGtaU0JoSUNkMGFISnZkeWNnYldWMGFHOWtYQ0lwTzF4dUlDQWdJQ0FnZlZ4dVhHNGdJQ0FnSUNCeVpYUjFjbTRnUTI5dWRHbHVkV1ZUWlc1MGFXNWxiRHRjYmlBZ0lDQjlYRzVjYmlBZ0lDQjJZWElnY21WamIzSmtJRDBnZEhKNVEyRjBZMmdvYldWMGFHOWtMQ0JrWld4bFoyRjBaUzVwZEdWeVlYUnZjaXdnWTI5dWRHVjRkQzVoY21jcE8xeHVYRzRnSUNBZ2FXWWdLSEpsWTI5eVpDNTBlWEJsSUQwOVBTQmNJblJvY205M1hDSXBJSHRjYmlBZ0lDQWdJR052Ym5SbGVIUXViV1YwYUc5a0lEMGdYQ0owYUhKdmQxd2lPMXh1SUNBZ0lDQWdZMjl1ZEdWNGRDNWhjbWNnUFNCeVpXTnZjbVF1WVhKbk8xeHVJQ0FnSUNBZ1kyOXVkR1Y0ZEM1a1pXeGxaMkYwWlNBOUlHNTFiR3c3WEc0Z0lDQWdJQ0J5WlhSMWNtNGdRMjl1ZEdsdWRXVlRaVzUwYVc1bGJEdGNiaUFnSUNCOVhHNWNiaUFnSUNCMllYSWdhVzVtYnlBOUlISmxZMjl5WkM1aGNtYzdYRzVjYmlBZ0lDQnBaaUFvSVNCcGJtWnZLU0I3WEc0Z0lDQWdJQ0JqYjI1MFpYaDBMbTFsZEdodlpDQTlJRndpZEdoeWIzZGNJanRjYmlBZ0lDQWdJR052Ym5SbGVIUXVZWEpuSUQwZ2JtVjNJRlI1Y0dWRmNuSnZjaWhjSW1sMFpYSmhkRzl5SUhKbGMzVnNkQ0JwY3lCdWIzUWdZVzRnYjJKcVpXTjBYQ0lwTzF4dUlDQWdJQ0FnWTI5dWRHVjRkQzVrWld4bFoyRjBaU0E5SUc1MWJHdzdYRzRnSUNBZ0lDQnlaWFIxY200Z1EyOXVkR2x1ZFdWVFpXNTBhVzVsYkR0Y2JpQWdJQ0I5WEc1Y2JpQWdJQ0JwWmlBb2FXNW1ieTVrYjI1bEtTQjdYRzRnSUNBZ0lDQXZMeUJCYzNOcFoyNGdkR2hsSUhKbGMzVnNkQ0J2WmlCMGFHVWdabWx1YVhOb1pXUWdaR1ZzWldkaGRHVWdkRzhnZEdobElIUmxiWEJ2Y21GeWVWeHVJQ0FnSUNBZ0x5OGdkbUZ5YVdGaWJHVWdjM0JsWTJsbWFXVmtJR0o1SUdSbGJHVm5ZWFJsTG5KbGMzVnNkRTVoYldVZ0tITmxaU0JrWld4bFoyRjBaVmxwWld4a0tTNWNiaUFnSUNBZ0lHTnZiblJsZUhSYlpHVnNaV2RoZEdVdWNtVnpkV3gwVG1GdFpWMGdQU0JwYm1adkxuWmhiSFZsTzF4dVhHNGdJQ0FnSUNBdkx5QlNaWE4xYldVZ1pYaGxZM1YwYVc5dUlHRjBJSFJvWlNCa1pYTnBjbVZrSUd4dlkyRjBhVzl1SUNoelpXVWdaR1ZzWldkaGRHVlphV1ZzWkNrdVhHNGdJQ0FnSUNCamIyNTBaWGgwTG01bGVIUWdQU0JrWld4bFoyRjBaUzV1WlhoMFRHOWpPMXh1WEc0Z0lDQWdJQ0F2THlCSlppQmpiMjUwWlhoMExtMWxkR2h2WkNCM1lYTWdYQ0owYUhKdmQxd2lJR0oxZENCMGFHVWdaR1ZzWldkaGRHVWdhR0Z1Wkd4bFpDQjBhR1ZjYmlBZ0lDQWdJQzh2SUdWNFkyVndkR2x2Yml3Z2JHVjBJSFJvWlNCdmRYUmxjaUJuWlc1bGNtRjBiM0lnY0hKdlkyVmxaQ0J1YjNKdFlXeHNlUzRnU1daY2JpQWdJQ0FnSUM4dklHTnZiblJsZUhRdWJXVjBhRzlrSUhkaGN5QmNJbTVsZUhSY0lpd2dabTl5WjJWMElHTnZiblJsZUhRdVlYSm5JSE5wYm1ObElHbDBJR2hoY3lCaVpXVnVYRzRnSUNBZ0lDQXZMeUJjSW1OdmJuTjFiV1ZrWENJZ1lua2dkR2hsSUdSbGJHVm5ZWFJsSUdsMFpYSmhkRzl5TGlCSlppQmpiMjUwWlhoMExtMWxkR2h2WkNCM1lYTmNiaUFnSUNBZ0lDOHZJRndpY21WMGRYSnVYQ0lzSUdGc2JHOTNJSFJvWlNCdmNtbG5hVzVoYkNBdWNtVjBkWEp1SUdOaGJHd2dkRzhnWTI5dWRHbHVkV1VnYVc0Z2RHaGxYRzRnSUNBZ0lDQXZMeUJ2ZFhSbGNpQm5aVzVsY21GMGIzSXVYRzRnSUNBZ0lDQnBaaUFvWTI5dWRHVjRkQzV0WlhSb2IyUWdJVDA5SUZ3aWNtVjBkWEp1WENJcElIdGNiaUFnSUNBZ0lDQWdZMjl1ZEdWNGRDNXRaWFJvYjJRZ1BTQmNJbTVsZUhSY0lqdGNiaUFnSUNBZ0lDQWdZMjl1ZEdWNGRDNWhjbWNnUFNCMWJtUmxabWx1WldRN1hHNGdJQ0FnSUNCOVhHNWNiaUFnSUNCOUlHVnNjMlVnZTF4dUlDQWdJQ0FnTHk4Z1VtVXRlV2xsYkdRZ2RHaGxJSEpsYzNWc2RDQnlaWFIxY201bFpDQmllU0IwYUdVZ1pHVnNaV2RoZEdVZ2JXVjBhRzlrTGx4dUlDQWdJQ0FnY21WMGRYSnVJR2x1Wm04N1hHNGdJQ0FnZlZ4dVhHNGdJQ0FnTHk4Z1ZHaGxJR1JsYkdWbllYUmxJR2wwWlhKaGRHOXlJR2x6SUdacGJtbHphR1ZrTENCemJ5Qm1iM0puWlhRZ2FYUWdZVzVrSUdOdmJuUnBiblZsSUhkcGRHaGNiaUFnSUNBdkx5QjBhR1VnYjNWMFpYSWdaMlZ1WlhKaGRHOXlMbHh1SUNBZ0lHTnZiblJsZUhRdVpHVnNaV2RoZEdVZ1BTQnVkV3hzTzF4dUlDQWdJSEpsZEhWeWJpQkRiMjUwYVc1MVpWTmxiblJwYm1Wc08xeHVJQ0I5WEc1Y2JpQWdMeThnUkdWbWFXNWxJRWRsYm1WeVlYUnZjaTV3Y205MGIzUjVjR1V1ZTI1bGVIUXNkR2h5YjNjc2NtVjBkWEp1ZlNCcGJpQjBaWEp0Y3lCdlppQjBhR1ZjYmlBZ0x5OGdkVzVwWm1sbFpDQXVYMmx1ZG05clpTQm9aV3h3WlhJZ2JXVjBhRzlrTGx4dUlDQmtaV1pwYm1WSmRHVnlZWFJ2Y2sxbGRHaHZaSE1vUjNBcE8xeHVYRzRnSUVkd1czUnZVM1J5YVc1blZHRm5VM2x0WW05c1hTQTlJRndpUjJWdVpYSmhkRzl5WENJN1hHNWNiaUFnTHk4Z1FTQkhaVzVsY21GMGIzSWdjMmh2ZFd4a0lHRnNkMkY1Y3lCeVpYUjFjbTRnYVhSelpXeG1JR0Z6SUhSb1pTQnBkR1Z5WVhSdmNpQnZZbXBsWTNRZ2QyaGxiaUIwYUdWY2JpQWdMeThnUUVCcGRHVnlZWFJ2Y2lCbWRXNWpkR2x2YmlCcGN5QmpZV3hzWldRZ2IyNGdhWFF1SUZOdmJXVWdZbkp2ZDNObGNuTW5JR2x0Y0d4bGJXVnVkR0YwYVc5dWN5QnZaaUIwYUdWY2JpQWdMeThnYVhSbGNtRjBiM0lnY0hKdmRHOTBlWEJsSUdOb1lXbHVJR2x1WTI5eWNtVmpkR3g1SUdsdGNHeGxiV1Z1ZENCMGFHbHpMQ0JqWVhWemFXNW5JSFJvWlNCSFpXNWxjbUYwYjNKY2JpQWdMeThnYjJKcVpXTjBJSFJ2SUc1dmRDQmlaU0J5WlhSMWNtNWxaQ0JtY205dElIUm9hWE1nWTJGc2JDNGdWR2hwY3lCbGJuTjFjbVZ6SUhSb1lYUWdaRzlsYzI0bmRDQm9ZWEJ3Wlc0dVhHNGdJQzh2SUZObFpTQm9kSFJ3Y3pvdkwyZHBkR2gxWWk1amIyMHZabUZqWldKdmIyc3ZjbVZuWlc1bGNtRjBiM0l2YVhOemRXVnpMekkzTkNCbWIzSWdiVzl5WlNCa1pYUmhhV3h6TGx4dUlDQkhjRnRwZEdWeVlYUnZjbE41YldKdmJGMGdQU0JtZFc1amRHbHZiaWdwSUh0Y2JpQWdJQ0J5WlhSMWNtNGdkR2hwY3p0Y2JpQWdmVHRjYmx4dUlDQkhjQzUwYjFOMGNtbHVaeUE5SUdaMWJtTjBhVzl1S0NrZ2UxeHVJQ0FnSUhKbGRIVnliaUJjSWx0dlltcGxZM1FnUjJWdVpYSmhkRzl5WFZ3aU8xeHVJQ0I5TzF4dVhHNGdJR1oxYm1OMGFXOXVJSEIxYzJoVWNubEZiblJ5ZVNoc2IyTnpLU0I3WEc0Z0lDQWdkbUZ5SUdWdWRISjVJRDBnZXlCMGNubE1iMk02SUd4dlkzTmJNRjBnZlR0Y2JseHVJQ0FnSUdsbUlDZ3hJR2x1SUd4dlkzTXBJSHRjYmlBZ0lDQWdJR1Z1ZEhKNUxtTmhkR05vVEc5aklEMGdiRzlqYzFzeFhUdGNiaUFnSUNCOVhHNWNiaUFnSUNCcFppQW9NaUJwYmlCc2IyTnpLU0I3WEc0Z0lDQWdJQ0JsYm5SeWVTNW1hVzVoYkd4NVRHOWpJRDBnYkc5amMxc3lYVHRjYmlBZ0lDQWdJR1Z1ZEhKNUxtRm1kR1Z5VEc5aklEMGdiRzlqYzFzelhUdGNiaUFnSUNCOVhHNWNiaUFnSUNCMGFHbHpMblJ5ZVVWdWRISnBaWE11Y0hWemFDaGxiblJ5ZVNrN1hHNGdJSDFjYmx4dUlDQm1kVzVqZEdsdmJpQnlaWE5sZEZSeWVVVnVkSEo1S0dWdWRISjVLU0I3WEc0Z0lDQWdkbUZ5SUhKbFkyOXlaQ0E5SUdWdWRISjVMbU52YlhCc1pYUnBiMjRnZkh3Z2UzMDdYRzRnSUNBZ2NtVmpiM0prTG5SNWNHVWdQU0JjSW01dmNtMWhiRndpTzF4dUlDQWdJR1JsYkdWMFpTQnlaV052Y21RdVlYSm5PMXh1SUNBZ0lHVnVkSEo1TG1OdmJYQnNaWFJwYjI0Z1BTQnlaV052Y21RN1hHNGdJSDFjYmx4dUlDQm1kVzVqZEdsdmJpQkRiMjUwWlhoMEtIUnllVXh2WTNOTWFYTjBLU0I3WEc0Z0lDQWdMeThnVkdobElISnZiM1FnWlc1MGNua2diMkpxWldOMElDaGxabVpsWTNScGRtVnNlU0JoSUhSeWVTQnpkR0YwWlcxbGJuUWdkMmwwYUc5MWRDQmhJR05oZEdOb1hHNGdJQ0FnTHk4Z2IzSWdZU0JtYVc1aGJHeDVJR0pzYjJOcktTQm5hWFpsY3lCMWN5QmhJSEJzWVdObElIUnZJSE4wYjNKbElIWmhiSFZsY3lCMGFISnZkMjRnWm5KdmJWeHVJQ0FnSUM4dklHeHZZMkYwYVc5dWN5QjNhR1Z5WlNCMGFHVnlaU0JwY3lCdWJ5QmxibU5zYjNOcGJtY2dkSEo1SUhOMFlYUmxiV1Z1ZEM1Y2JpQWdJQ0IwYUdsekxuUnllVVZ1ZEhKcFpYTWdQU0JiZXlCMGNubE1iMk02SUZ3aWNtOXZkRndpSUgxZE8xeHVJQ0FnSUhSeWVVeHZZM05NYVhOMExtWnZja1ZoWTJnb2NIVnphRlJ5ZVVWdWRISjVMQ0IwYUdsektUdGNiaUFnSUNCMGFHbHpMbkpsYzJWMEtIUnlkV1VwTzF4dUlDQjlYRzVjYmlBZ1pYaHdiM0owY3k1clpYbHpJRDBnWm5WdVkzUnBiMjRvYjJKcVpXTjBLU0I3WEc0Z0lDQWdkbUZ5SUd0bGVYTWdQU0JiWFR0Y2JpQWdJQ0JtYjNJZ0tIWmhjaUJyWlhrZ2FXNGdiMkpxWldOMEtTQjdYRzRnSUNBZ0lDQnJaWGx6TG5CMWMyZ29hMlY1S1R0Y2JpQWdJQ0I5WEc0Z0lDQWdhMlY1Y3k1eVpYWmxjbk5sS0NrN1hHNWNiaUFnSUNBdkx5QlNZWFJvWlhJZ2RHaGhiaUJ5WlhSMWNtNXBibWNnWVc0Z2IySnFaV04wSUhkcGRHZ2dZU0J1WlhoMElHMWxkR2h2WkN3Z2QyVWdhMlZsY0Z4dUlDQWdJQzh2SUhSb2FXNW5jeUJ6YVcxd2JHVWdZVzVrSUhKbGRIVnliaUIwYUdVZ2JtVjRkQ0JtZFc1amRHbHZiaUJwZEhObGJHWXVYRzRnSUNBZ2NtVjBkWEp1SUdaMWJtTjBhVzl1SUc1bGVIUW9LU0I3WEc0Z0lDQWdJQ0IzYUdsc1pTQW9hMlY1Y3k1c1pXNW5kR2dwSUh0Y2JpQWdJQ0FnSUNBZ2RtRnlJR3RsZVNBOUlHdGxlWE11Y0c5d0tDazdYRzRnSUNBZ0lDQWdJR2xtSUNoclpYa2dhVzRnYjJKcVpXTjBLU0I3WEc0Z0lDQWdJQ0FnSUNBZ2JtVjRkQzUyWVd4MVpTQTlJR3RsZVR0Y2JpQWdJQ0FnSUNBZ0lDQnVaWGgwTG1SdmJtVWdQU0JtWVd4elpUdGNiaUFnSUNBZ0lDQWdJQ0J5WlhSMWNtNGdibVY0ZER0Y2JpQWdJQ0FnSUNBZ2ZWeHVJQ0FnSUNBZ2ZWeHVYRzRnSUNBZ0lDQXZMeUJVYnlCaGRtOXBaQ0JqY21WaGRHbHVaeUJoYmlCaFpHUnBkR2x2Ym1Gc0lHOWlhbVZqZEN3Z2QyVWdhblZ6ZENCb1lXNW5JSFJvWlNBdWRtRnNkV1ZjYmlBZ0lDQWdJQzh2SUdGdVpDQXVaRzl1WlNCd2NtOXdaWEowYVdWeklHOW1aaUIwYUdVZ2JtVjRkQ0JtZFc1amRHbHZiaUJ2WW1wbFkzUWdhWFJ6Wld4bUxpQlVhR2x6WEc0Z0lDQWdJQ0F2THlCaGJITnZJR1Z1YzNWeVpYTWdkR2hoZENCMGFHVWdiV2x1YVdacFpYSWdkMmxzYkNCdWIzUWdZVzV2Ym5sdGFYcGxJSFJvWlNCbWRXNWpkR2x2Ymk1Y2JpQWdJQ0FnSUc1bGVIUXVaRzl1WlNBOUlIUnlkV1U3WEc0Z0lDQWdJQ0J5WlhSMWNtNGdibVY0ZER0Y2JpQWdJQ0I5TzF4dUlDQjlPMXh1WEc0Z0lHWjFibU4wYVc5dUlIWmhiSFZsY3locGRHVnlZV0pzWlNrZ2UxeHVJQ0FnSUdsbUlDaHBkR1Z5WVdKc1pTa2dlMXh1SUNBZ0lDQWdkbUZ5SUdsMFpYSmhkRzl5VFdWMGFHOWtJRDBnYVhSbGNtRmliR1ZiYVhSbGNtRjBiM0pUZVcxaWIyeGRPMXh1SUNBZ0lDQWdhV1lnS0dsMFpYSmhkRzl5VFdWMGFHOWtLU0I3WEc0Z0lDQWdJQ0FnSUhKbGRIVnliaUJwZEdWeVlYUnZjazFsZEdodlpDNWpZV3hzS0dsMFpYSmhZbXhsS1R0Y2JpQWdJQ0FnSUgxY2JseHVJQ0FnSUNBZ2FXWWdLSFI1Y0dWdlppQnBkR1Z5WVdKc1pTNXVaWGgwSUQwOVBTQmNJbVoxYm1OMGFXOXVYQ0lwSUh0Y2JpQWdJQ0FnSUNBZ2NtVjBkWEp1SUdsMFpYSmhZbXhsTzF4dUlDQWdJQ0FnZlZ4dVhHNGdJQ0FnSUNCcFppQW9JV2x6VG1GT0tHbDBaWEpoWW14bExteGxibWQwYUNrcElIdGNiaUFnSUNBZ0lDQWdkbUZ5SUdrZ1BTQXRNU3dnYm1WNGRDQTlJR1oxYm1OMGFXOXVJRzVsZUhRb0tTQjdYRzRnSUNBZ0lDQWdJQ0FnZDJocGJHVWdLQ3NyYVNBOElHbDBaWEpoWW14bExteGxibWQwYUNrZ2UxeHVJQ0FnSUNBZ0lDQWdJQ0FnYVdZZ0tHaGhjMDkzYmk1allXeHNLR2wwWlhKaFlteGxMQ0JwS1NrZ2UxeHVJQ0FnSUNBZ0lDQWdJQ0FnSUNCdVpYaDBMblpoYkhWbElEMGdhWFJsY21GaWJHVmJhVjA3WEc0Z0lDQWdJQ0FnSUNBZ0lDQWdJRzVsZUhRdVpHOXVaU0E5SUdaaGJITmxPMXh1SUNBZ0lDQWdJQ0FnSUNBZ0lDQnlaWFIxY200Z2JtVjRkRHRjYmlBZ0lDQWdJQ0FnSUNBZ0lIMWNiaUFnSUNBZ0lDQWdJQ0I5WEc1Y2JpQWdJQ0FnSUNBZ0lDQnVaWGgwTG5aaGJIVmxJRDBnZFc1a1pXWnBibVZrTzF4dUlDQWdJQ0FnSUNBZ0lHNWxlSFF1Wkc5dVpTQTlJSFJ5ZFdVN1hHNWNiaUFnSUNBZ0lDQWdJQ0J5WlhSMWNtNGdibVY0ZER0Y2JpQWdJQ0FnSUNBZ2ZUdGNibHh1SUNBZ0lDQWdJQ0J5WlhSMWNtNGdibVY0ZEM1dVpYaDBJRDBnYm1WNGREdGNiaUFnSUNBZ0lIMWNiaUFnSUNCOVhHNWNiaUFnSUNBdkx5QlNaWFIxY200Z1lXNGdhWFJsY21GMGIzSWdkMmwwYUNCdWJ5QjJZV3gxWlhNdVhHNGdJQ0FnY21WMGRYSnVJSHNnYm1WNGREb2daRzl1WlZKbGMzVnNkQ0I5TzF4dUlDQjlYRzRnSUdWNGNHOXlkSE11ZG1Gc2RXVnpJRDBnZG1Gc2RXVnpPMXh1WEc0Z0lHWjFibU4wYVc5dUlHUnZibVZTWlhOMWJIUW9LU0I3WEc0Z0lDQWdjbVYwZFhKdUlIc2dkbUZzZFdVNklIVnVaR1ZtYVc1bFpDd2daRzl1WlRvZ2RISjFaU0I5TzF4dUlDQjlYRzVjYmlBZ1EyOXVkR1Y0ZEM1d2NtOTBiM1I1Y0dVZ1BTQjdYRzRnSUNBZ1kyOXVjM1J5ZFdOMGIzSTZJRU52Ym5SbGVIUXNYRzVjYmlBZ0lDQnlaWE5sZERvZ1puVnVZM1JwYjI0b2MydHBjRlJsYlhCU1pYTmxkQ2tnZTF4dUlDQWdJQ0FnZEdocGN5NXdjbVYySUQwZ01EdGNiaUFnSUNBZ0lIUm9hWE11Ym1WNGRDQTlJREE3WEc0Z0lDQWdJQ0F2THlCU1pYTmxkSFJwYm1jZ1kyOXVkR1Y0ZEM1ZmMyVnVkQ0JtYjNJZ2JHVm5ZV041SUhOMWNIQnZjblFnYjJZZ1FtRmlaV3duYzF4dUlDQWdJQ0FnTHk4Z1puVnVZM1JwYjI0dWMyVnVkQ0JwYlhCc1pXMWxiblJoZEdsdmJpNWNiaUFnSUNBZ0lIUm9hWE11YzJWdWRDQTlJSFJvYVhNdVgzTmxiblFnUFNCMWJtUmxabWx1WldRN1hHNGdJQ0FnSUNCMGFHbHpMbVJ2Ym1VZ1BTQm1ZV3h6WlR0Y2JpQWdJQ0FnSUhSb2FYTXVaR1ZzWldkaGRHVWdQU0J1ZFd4c08xeHVYRzRnSUNBZ0lDQjBhR2x6TG0xbGRHaHZaQ0E5SUZ3aWJtVjRkRndpTzF4dUlDQWdJQ0FnZEdocGN5NWhjbWNnUFNCMWJtUmxabWx1WldRN1hHNWNiaUFnSUNBZ0lIUm9hWE11ZEhKNVJXNTBjbWxsY3k1bWIzSkZZV05vS0hKbGMyVjBWSEo1Ulc1MGNua3BPMXh1WEc0Z0lDQWdJQ0JwWmlBb0lYTnJhWEJVWlcxd1VtVnpaWFFwSUh0Y2JpQWdJQ0FnSUNBZ1ptOXlJQ2gyWVhJZ2JtRnRaU0JwYmlCMGFHbHpLU0I3WEc0Z0lDQWdJQ0FnSUNBZ0x5OGdUbTkwSUhOMWNtVWdZV0p2ZFhRZ2RHaGxJRzl3ZEdsdFlXd2diM0prWlhJZ2IyWWdkR2hsYzJVZ1kyOXVaR2wwYVc5dWN6cGNiaUFnSUNBZ0lDQWdJQ0JwWmlBb2JtRnRaUzVqYUdGeVFYUW9NQ2tnUFQwOUlGd2lkRndpSUNZbVhHNGdJQ0FnSUNBZ0lDQWdJQ0FnSUdoaGMwOTNiaTVqWVd4c0tIUm9hWE1zSUc1aGJXVXBJQ1ltWEc0Z0lDQWdJQ0FnSUNBZ0lDQWdJQ0ZwYzA1aFRpZ3JibUZ0WlM1emJHbGpaU2d4S1NrcElIdGNiaUFnSUNBZ0lDQWdJQ0FnSUhSb2FYTmJibUZ0WlYwZ1BTQjFibVJsWm1sdVpXUTdYRzRnSUNBZ0lDQWdJQ0FnZlZ4dUlDQWdJQ0FnSUNCOVhHNGdJQ0FnSUNCOVhHNGdJQ0FnZlN4Y2JseHVJQ0FnSUhOMGIzQTZJR1oxYm1OMGFXOXVLQ2tnZTF4dUlDQWdJQ0FnZEdocGN5NWtiMjVsSUQwZ2RISjFaVHRjYmx4dUlDQWdJQ0FnZG1GeUlISnZiM1JGYm5SeWVTQTlJSFJvYVhNdWRISjVSVzUwY21sbGMxc3dYVHRjYmlBZ0lDQWdJSFpoY2lCeWIyOTBVbVZqYjNKa0lEMGdjbTl2ZEVWdWRISjVMbU52YlhCc1pYUnBiMjQ3WEc0Z0lDQWdJQ0JwWmlBb2NtOXZkRkpsWTI5eVpDNTBlWEJsSUQwOVBTQmNJblJvY205M1hDSXBJSHRjYmlBZ0lDQWdJQ0FnZEdoeWIzY2djbTl2ZEZKbFkyOXlaQzVoY21jN1hHNGdJQ0FnSUNCOVhHNWNiaUFnSUNBZ0lISmxkSFZ5YmlCMGFHbHpMbkoyWVd3N1hHNGdJQ0FnZlN4Y2JseHVJQ0FnSUdScGMzQmhkR05vUlhoalpYQjBhVzl1T2lCbWRXNWpkR2x2YmlobGVHTmxjSFJwYjI0cElIdGNiaUFnSUNBZ0lHbG1JQ2gwYUdsekxtUnZibVVwSUh0Y2JpQWdJQ0FnSUNBZ2RHaHliM2NnWlhoalpYQjBhVzl1TzF4dUlDQWdJQ0FnZlZ4dVhHNGdJQ0FnSUNCMllYSWdZMjl1ZEdWNGRDQTlJSFJvYVhNN1hHNGdJQ0FnSUNCbWRXNWpkR2x2YmlCb1lXNWtiR1VvYkc5akxDQmpZWFZuYUhRcElIdGNiaUFnSUNBZ0lDQWdjbVZqYjNKa0xuUjVjR1VnUFNCY0luUm9jbTkzWENJN1hHNGdJQ0FnSUNBZ0lISmxZMjl5WkM1aGNtY2dQU0JsZUdObGNIUnBiMjQ3WEc0Z0lDQWdJQ0FnSUdOdmJuUmxlSFF1Ym1WNGRDQTlJR3h2WXp0Y2JseHVJQ0FnSUNBZ0lDQnBaaUFvWTJGMVoyaDBLU0I3WEc0Z0lDQWdJQ0FnSUNBZ0x5OGdTV1lnZEdobElHUnBjM0JoZEdOb1pXUWdaWGhqWlhCMGFXOXVJSGRoY3lCallYVm5hSFFnWW5rZ1lTQmpZWFJqYUNCaWJHOWpheXhjYmlBZ0lDQWdJQ0FnSUNBdkx5QjBhR1Z1SUd4bGRDQjBhR0YwSUdOaGRHTm9JR0pzYjJOcklHaGhibVJzWlNCMGFHVWdaWGhqWlhCMGFXOXVJRzV2Y20xaGJHeDVMbHh1SUNBZ0lDQWdJQ0FnSUdOdmJuUmxlSFF1YldWMGFHOWtJRDBnWENKdVpYaDBYQ0k3WEc0Z0lDQWdJQ0FnSUNBZ1kyOXVkR1Y0ZEM1aGNtY2dQU0IxYm1SbFptbHVaV1E3WEc0Z0lDQWdJQ0FnSUgxY2JseHVJQ0FnSUNBZ0lDQnlaWFIxY200Z0lTRWdZMkYxWjJoME8xeHVJQ0FnSUNBZ2ZWeHVYRzRnSUNBZ0lDQm1iM0lnS0haaGNpQnBJRDBnZEdocGN5NTBjbmxGYm5SeWFXVnpMbXhsYm1kMGFDQXRJREU3SUdrZ1BqMGdNRHNnTFMxcEtTQjdYRzRnSUNBZ0lDQWdJSFpoY2lCbGJuUnllU0E5SUhSb2FYTXVkSEo1Ulc1MGNtbGxjMXRwWFR0Y2JpQWdJQ0FnSUNBZ2RtRnlJSEpsWTI5eVpDQTlJR1Z1ZEhKNUxtTnZiWEJzWlhScGIyNDdYRzVjYmlBZ0lDQWdJQ0FnYVdZZ0tHVnVkSEo1TG5SeWVVeHZZeUE5UFQwZ1hDSnliMjkwWENJcElIdGNiaUFnSUNBZ0lDQWdJQ0F2THlCRmVHTmxjSFJwYjI0Z2RHaHliM2R1SUc5MWRITnBaR1VnYjJZZ1lXNTVJSFJ5ZVNCaWJHOWpheUIwYUdGMElHTnZkV3hrSUdoaGJtUnNaVnh1SUNBZ0lDQWdJQ0FnSUM4dklHbDBMQ0J6YnlCelpYUWdkR2hsSUdOdmJYQnNaWFJwYjI0Z2RtRnNkV1VnYjJZZ2RHaGxJR1Z1ZEdseVpTQm1kVzVqZEdsdmJpQjBiMXh1SUNBZ0lDQWdJQ0FnSUM4dklIUm9jbTkzSUhSb1pTQmxlR05sY0hScGIyNHVYRzRnSUNBZ0lDQWdJQ0FnY21WMGRYSnVJR2hoYm1Sc1pTaGNJbVZ1WkZ3aUtUdGNiaUFnSUNBZ0lDQWdmVnh1WEc0Z0lDQWdJQ0FnSUdsbUlDaGxiblJ5ZVM1MGNubE1iMk1nUEQwZ2RHaHBjeTV3Y21WMktTQjdYRzRnSUNBZ0lDQWdJQ0FnZG1GeUlHaGhjME5oZEdOb0lEMGdhR0Z6VDNkdUxtTmhiR3dvWlc1MGNua3NJRndpWTJGMFkyaE1iMk5jSWlrN1hHNGdJQ0FnSUNBZ0lDQWdkbUZ5SUdoaGMwWnBibUZzYkhrZ1BTQm9ZWE5QZDI0dVkyRnNiQ2hsYm5SeWVTd2dYQ0ptYVc1aGJHeDVURzlqWENJcE8xeHVYRzRnSUNBZ0lDQWdJQ0FnYVdZZ0tHaGhjME5oZEdOb0lDWW1JR2hoYzBacGJtRnNiSGtwSUh0Y2JpQWdJQ0FnSUNBZ0lDQWdJR2xtSUNoMGFHbHpMbkJ5WlhZZ1BDQmxiblJ5ZVM1allYUmphRXh2WXlrZ2UxeHVJQ0FnSUNBZ0lDQWdJQ0FnSUNCeVpYUjFjbTRnYUdGdVpHeGxLR1Z1ZEhKNUxtTmhkR05vVEc5akxDQjBjblZsS1R0Y2JpQWdJQ0FnSUNBZ0lDQWdJSDBnWld4elpTQnBaaUFvZEdocGN5NXdjbVYySUR3Z1pXNTBjbmt1Wm1sdVlXeHNlVXh2WXlrZ2UxeHVJQ0FnSUNBZ0lDQWdJQ0FnSUNCeVpYUjFjbTRnYUdGdVpHeGxLR1Z1ZEhKNUxtWnBibUZzYkhsTWIyTXBPMXh1SUNBZ0lDQWdJQ0FnSUNBZ2ZWeHVYRzRnSUNBZ0lDQWdJQ0FnZlNCbGJITmxJR2xtSUNob1lYTkRZWFJqYUNrZ2UxeHVJQ0FnSUNBZ0lDQWdJQ0FnYVdZZ0tIUm9hWE11Y0hKbGRpQThJR1Z1ZEhKNUxtTmhkR05vVEc5aktTQjdYRzRnSUNBZ0lDQWdJQ0FnSUNBZ0lISmxkSFZ5YmlCb1lXNWtiR1VvWlc1MGNua3VZMkYwWTJoTWIyTXNJSFJ5ZFdVcE8xeHVJQ0FnSUNBZ0lDQWdJQ0FnZlZ4dVhHNGdJQ0FnSUNBZ0lDQWdmU0JsYkhObElHbG1JQ2hvWVhOR2FXNWhiR3g1S1NCN1hHNGdJQ0FnSUNBZ0lDQWdJQ0JwWmlBb2RHaHBjeTV3Y21WMklEd2daVzUwY25rdVptbHVZV3hzZVV4dll5a2dlMXh1SUNBZ0lDQWdJQ0FnSUNBZ0lDQnlaWFIxY200Z2FHRnVaR3hsS0dWdWRISjVMbVpwYm1Gc2JIbE1iMk1wTzF4dUlDQWdJQ0FnSUNBZ0lDQWdmVnh1WEc0Z0lDQWdJQ0FnSUNBZ2ZTQmxiSE5sSUh0Y2JpQWdJQ0FnSUNBZ0lDQWdJSFJvY205M0lHNWxkeUJGY25KdmNpaGNJblJ5ZVNCemRHRjBaVzFsYm5RZ2QybDBhRzkxZENCallYUmphQ0J2Y2lCbWFXNWhiR3g1WENJcE8xeHVJQ0FnSUNBZ0lDQWdJSDFjYmlBZ0lDQWdJQ0FnZlZ4dUlDQWdJQ0FnZlZ4dUlDQWdJSDBzWEc1Y2JpQWdJQ0JoWW5KMWNIUTZJR1oxYm1OMGFXOXVLSFI1Y0dVc0lHRnlaeWtnZTF4dUlDQWdJQ0FnWm05eUlDaDJZWElnYVNBOUlIUm9hWE11ZEhKNVJXNTBjbWxsY3k1c1pXNW5kR2dnTFNBeE95QnBJRDQ5SURBN0lDMHRhU2tnZTF4dUlDQWdJQ0FnSUNCMllYSWdaVzUwY25rZ1BTQjBhR2x6TG5SeWVVVnVkSEpwWlhOYmFWMDdYRzRnSUNBZ0lDQWdJR2xtSUNobGJuUnllUzUwY25sTWIyTWdQRDBnZEdocGN5NXdjbVYySUNZbVhHNGdJQ0FnSUNBZ0lDQWdJQ0JvWVhOUGQyNHVZMkZzYkNobGJuUnllU3dnWENKbWFXNWhiR3g1VEc5alhDSXBJQ1ltWEc0Z0lDQWdJQ0FnSUNBZ0lDQjBhR2x6TG5CeVpYWWdQQ0JsYm5SeWVTNW1hVzVoYkd4NVRHOWpLU0I3WEc0Z0lDQWdJQ0FnSUNBZ2RtRnlJR1pwYm1Gc2JIbEZiblJ5ZVNBOUlHVnVkSEo1TzF4dUlDQWdJQ0FnSUNBZ0lHSnlaV0ZyTzF4dUlDQWdJQ0FnSUNCOVhHNGdJQ0FnSUNCOVhHNWNiaUFnSUNBZ0lHbG1JQ2htYVc1aGJHeDVSVzUwY25rZ0ppWmNiaUFnSUNBZ0lDQWdJQ0FvZEhsd1pTQTlQVDBnWENKaWNtVmhhMXdpSUh4OFhHNGdJQ0FnSUNBZ0lDQWdJSFI1Y0dVZ1BUMDlJRndpWTI5dWRHbHVkV1ZjSWlrZ0ppWmNiaUFnSUNBZ0lDQWdJQ0JtYVc1aGJHeDVSVzUwY25rdWRISjVURzlqSUR3OUlHRnlaeUFtSmx4dUlDQWdJQ0FnSUNBZ0lHRnlaeUE4UFNCbWFXNWhiR3g1Ulc1MGNua3VabWx1WVd4c2VVeHZZeWtnZTF4dUlDQWdJQ0FnSUNBdkx5QkpaMjV2Y21VZ2RHaGxJR1pwYm1Gc2JIa2daVzUwY25rZ2FXWWdZMjl1ZEhKdmJDQnBjeUJ1YjNRZ2FuVnRjR2x1WnlCMGJ5QmhYRzRnSUNBZ0lDQWdJQzh2SUd4dlkyRjBhVzl1SUc5MWRITnBaR1VnZEdobElIUnllUzlqWVhSamFDQmliRzlqYXk1Y2JpQWdJQ0FnSUNBZ1ptbHVZV3hzZVVWdWRISjVJRDBnYm5Wc2JEdGNiaUFnSUNBZ0lIMWNibHh1SUNBZ0lDQWdkbUZ5SUhKbFkyOXlaQ0E5SUdacGJtRnNiSGxGYm5SeWVTQS9JR1pwYm1Gc2JIbEZiblJ5ZVM1amIyMXdiR1YwYVc5dUlEb2dlMzA3WEc0Z0lDQWdJQ0J5WldOdmNtUXVkSGx3WlNBOUlIUjVjR1U3WEc0Z0lDQWdJQ0J5WldOdmNtUXVZWEpuSUQwZ1lYSm5PMXh1WEc0Z0lDQWdJQ0JwWmlBb1ptbHVZV3hzZVVWdWRISjVLU0I3WEc0Z0lDQWdJQ0FnSUhSb2FYTXViV1YwYUc5a0lEMGdYQ0p1WlhoMFhDSTdYRzRnSUNBZ0lDQWdJSFJvYVhNdWJtVjRkQ0E5SUdacGJtRnNiSGxGYm5SeWVTNW1hVzVoYkd4NVRHOWpPMXh1SUNBZ0lDQWdJQ0J5WlhSMWNtNGdRMjl1ZEdsdWRXVlRaVzUwYVc1bGJEdGNiaUFnSUNBZ0lIMWNibHh1SUNBZ0lDQWdjbVYwZFhKdUlIUm9hWE11WTI5dGNHeGxkR1VvY21WamIzSmtLVHRjYmlBZ0lDQjlMRnh1WEc0Z0lDQWdZMjl0Y0d4bGRHVTZJR1oxYm1OMGFXOXVLSEpsWTI5eVpDd2dZV1owWlhKTWIyTXBJSHRjYmlBZ0lDQWdJR2xtSUNoeVpXTnZjbVF1ZEhsd1pTQTlQVDBnWENKMGFISnZkMXdpS1NCN1hHNGdJQ0FnSUNBZ0lIUm9jbTkzSUhKbFkyOXlaQzVoY21jN1hHNGdJQ0FnSUNCOVhHNWNiaUFnSUNBZ0lHbG1JQ2h5WldOdmNtUXVkSGx3WlNBOVBUMGdYQ0ppY21WaGExd2lJSHg4WEc0Z0lDQWdJQ0FnSUNBZ2NtVmpiM0prTG5SNWNHVWdQVDA5SUZ3aVkyOXVkR2x1ZFdWY0lpa2dlMXh1SUNBZ0lDQWdJQ0IwYUdsekxtNWxlSFFnUFNCeVpXTnZjbVF1WVhKbk8xeHVJQ0FnSUNBZ2ZTQmxiSE5sSUdsbUlDaHlaV052Y21RdWRIbHdaU0E5UFQwZ1hDSnlaWFIxY201Y0lpa2dlMXh1SUNBZ0lDQWdJQ0IwYUdsekxuSjJZV3dnUFNCMGFHbHpMbUZ5WnlBOUlISmxZMjl5WkM1aGNtYzdYRzRnSUNBZ0lDQWdJSFJvYVhNdWJXVjBhRzlrSUQwZ1hDSnlaWFIxY201Y0lqdGNiaUFnSUNBZ0lDQWdkR2hwY3k1dVpYaDBJRDBnWENKbGJtUmNJanRjYmlBZ0lDQWdJSDBnWld4elpTQnBaaUFvY21WamIzSmtMblI1Y0dVZ1BUMDlJRndpYm05eWJXRnNYQ0lnSmlZZ1lXWjBaWEpNYjJNcElIdGNiaUFnSUNBZ0lDQWdkR2hwY3k1dVpYaDBJRDBnWVdaMFpYSk1iMk03WEc0Z0lDQWdJQ0I5WEc1Y2JpQWdJQ0FnSUhKbGRIVnliaUJEYjI1MGFXNTFaVk5sYm5ScGJtVnNPMXh1SUNBZ0lIMHNYRzVjYmlBZ0lDQm1hVzVwYzJnNklHWjFibU4wYVc5dUtHWnBibUZzYkhsTWIyTXBJSHRjYmlBZ0lDQWdJR1p2Y2lBb2RtRnlJR2tnUFNCMGFHbHpMblJ5ZVVWdWRISnBaWE11YkdWdVozUm9JQzBnTVRzZ2FTQStQU0F3T3lBdExXa3BJSHRjYmlBZ0lDQWdJQ0FnZG1GeUlHVnVkSEo1SUQwZ2RHaHBjeTUwY25sRmJuUnlhV1Z6VzJsZE8xeHVJQ0FnSUNBZ0lDQnBaaUFvWlc1MGNua3VabWx1WVd4c2VVeHZZeUE5UFQwZ1ptbHVZV3hzZVV4dll5a2dlMXh1SUNBZ0lDQWdJQ0FnSUhSb2FYTXVZMjl0Y0d4bGRHVW9aVzUwY25rdVkyOXRjR3hsZEdsdmJpd2daVzUwY25rdVlXWjBaWEpNYjJNcE8xeHVJQ0FnSUNBZ0lDQWdJSEpsYzJWMFZISjVSVzUwY25rb1pXNTBjbmtwTzF4dUlDQWdJQ0FnSUNBZ0lISmxkSFZ5YmlCRGIyNTBhVzUxWlZObGJuUnBibVZzTzF4dUlDQWdJQ0FnSUNCOVhHNGdJQ0FnSUNCOVhHNGdJQ0FnZlN4Y2JseHVJQ0FnSUZ3aVkyRjBZMmhjSWpvZ1puVnVZM1JwYjI0b2RISjVURzlqS1NCN1hHNGdJQ0FnSUNCbWIzSWdLSFpoY2lCcElEMGdkR2hwY3k1MGNubEZiblJ5YVdWekxteGxibWQwYUNBdElERTdJR2tnUGowZ01Ec2dMUzFwS1NCN1hHNGdJQ0FnSUNBZ0lIWmhjaUJsYm5SeWVTQTlJSFJvYVhNdWRISjVSVzUwY21sbGMxdHBYVHRjYmlBZ0lDQWdJQ0FnYVdZZ0tHVnVkSEo1TG5SeWVVeHZZeUE5UFQwZ2RISjVURzlqS1NCN1hHNGdJQ0FnSUNBZ0lDQWdkbUZ5SUhKbFkyOXlaQ0E5SUdWdWRISjVMbU52YlhCc1pYUnBiMjQ3WEc0Z0lDQWdJQ0FnSUNBZ2FXWWdLSEpsWTI5eVpDNTBlWEJsSUQwOVBTQmNJblJvY205M1hDSXBJSHRjYmlBZ0lDQWdJQ0FnSUNBZ0lIWmhjaUIwYUhKdmQyNGdQU0J5WldOdmNtUXVZWEpuTzF4dUlDQWdJQ0FnSUNBZ0lDQWdjbVZ6WlhSVWNubEZiblJ5ZVNobGJuUnllU2s3WEc0Z0lDQWdJQ0FnSUNBZ2ZWeHVJQ0FnSUNBZ0lDQWdJSEpsZEhWeWJpQjBhSEp2ZDI0N1hHNGdJQ0FnSUNBZ0lIMWNiaUFnSUNBZ0lIMWNibHh1SUNBZ0lDQWdMeThnVkdobElHTnZiblJsZUhRdVkyRjBZMmdnYldWMGFHOWtJRzExYzNRZ2IyNXNlU0JpWlNCallXeHNaV1FnZDJsMGFDQmhJR3h2WTJGMGFXOXVYRzRnSUNBZ0lDQXZMeUJoY21kMWJXVnVkQ0IwYUdGMElHTnZjbkpsYzNCdmJtUnpJSFJ2SUdFZ2EyNXZkMjRnWTJGMFkyZ2dZbXh2WTJzdVhHNGdJQ0FnSUNCMGFISnZkeUJ1WlhjZ1JYSnliM0lvWENKcGJHeGxaMkZzSUdOaGRHTm9JR0YwZEdWdGNIUmNJaWs3WEc0Z0lDQWdmU3hjYmx4dUlDQWdJR1JsYkdWbllYUmxXV2xsYkdRNklHWjFibU4wYVc5dUtHbDBaWEpoWW14bExDQnlaWE4xYkhST1lXMWxMQ0J1WlhoMFRHOWpLU0I3WEc0Z0lDQWdJQ0IwYUdsekxtUmxiR1ZuWVhSbElEMGdlMXh1SUNBZ0lDQWdJQ0JwZEdWeVlYUnZjam9nZG1Gc2RXVnpLR2wwWlhKaFlteGxLU3hjYmlBZ0lDQWdJQ0FnY21WemRXeDBUbUZ0WlRvZ2NtVnpkV3gwVG1GdFpTeGNiaUFnSUNBZ0lDQWdibVY0ZEV4dll6b2dibVY0ZEV4dlkxeHVJQ0FnSUNBZ2ZUdGNibHh1SUNBZ0lDQWdhV1lnS0hSb2FYTXViV1YwYUc5a0lEMDlQU0JjSW01bGVIUmNJaWtnZTF4dUlDQWdJQ0FnSUNBdkx5QkVaV3hwWW1WeVlYUmxiSGtnWm05eVoyVjBJSFJvWlNCc1lYTjBJSE5sYm5RZ2RtRnNkV1VnYzI4Z2RHaGhkQ0IzWlNCa2IyNG5kRnh1SUNBZ0lDQWdJQ0F2THlCaFkyTnBaR1Z1ZEdGc2JIa2djR0Z6Y3lCcGRDQnZiaUIwYnlCMGFHVWdaR1ZzWldkaGRHVXVYRzRnSUNBZ0lDQWdJSFJvYVhNdVlYSm5JRDBnZFc1a1pXWnBibVZrTzF4dUlDQWdJQ0FnZlZ4dVhHNGdJQ0FnSUNCeVpYUjFjbTRnUTI5dWRHbHVkV1ZUWlc1MGFXNWxiRHRjYmlBZ0lDQjlYRzRnSUgwN1hHNWNiaUFnTHk4Z1VtVm5ZWEprYkdWemN5QnZaaUIzYUdWMGFHVnlJSFJvYVhNZ2MyTnlhWEIwSUdseklHVjRaV04xZEdsdVp5QmhjeUJoSUVOdmJXMXZia3BUSUcxdlpIVnNaVnh1SUNBdkx5QnZjaUJ1YjNRc0lISmxkSFZ5YmlCMGFHVWdjblZ1ZEdsdFpTQnZZbXBsWTNRZ2MyOGdkR2hoZENCM1pTQmpZVzRnWkdWamJHRnlaU0IwYUdVZ2RtRnlhV0ZpYkdWY2JpQWdMeThnY21WblpXNWxjbUYwYjNKU2RXNTBhVzFsSUdsdUlIUm9aU0J2ZFhSbGNpQnpZMjl3WlN3Z2QyaHBZMmdnWVd4c2IzZHpJSFJvYVhNZ2JXOWtkV3hsSUhSdklHSmxYRzRnSUM4dklHbHVhbVZqZEdWa0lHVmhjMmxzZVNCaWVTQmdZbWx1TDNKbFoyVnVaWEpoZEc5eUlDMHRhVzVqYkhWa1pTMXlkVzUwYVcxbElITmpjbWx3ZEM1cWMyQXVYRzRnSUhKbGRIVnliaUJsZUhCdmNuUnpPMXh1WEc1OUtGeHVJQ0F2THlCSlppQjBhR2x6SUhOamNtbHdkQ0JwY3lCbGVHVmpkWFJwYm1jZ1lYTWdZU0JEYjIxdGIyNUtVeUJ0YjJSMWJHVXNJSFZ6WlNCdGIyUjFiR1V1Wlhod2IzSjBjMXh1SUNBdkx5QmhjeUIwYUdVZ2NtVm5aVzVsY21GMGIzSlNkVzUwYVcxbElHNWhiV1Z6Y0dGalpTNGdUM1JvWlhKM2FYTmxJR055WldGMFpTQmhJRzVsZHlCbGJYQjBlVnh1SUNBdkx5QnZZbXBsWTNRdUlFVnBkR2hsY2lCM1lYa3NJSFJvWlNCeVpYTjFiSFJwYm1jZ2IySnFaV04wSUhkcGJHd2dZbVVnZFhObFpDQjBieUJwYm1sMGFXRnNhWHBsWEc0Z0lDOHZJSFJvWlNCeVpXZGxibVZ5WVhSdmNsSjFiblJwYldVZ2RtRnlhV0ZpYkdVZ1lYUWdkR2hsSUhSdmNDQnZaaUIwYUdseklHWnBiR1V1WEc0Z0lIUjVjR1Z2WmlCdGIyUjFiR1VnUFQwOUlGd2liMkpxWldOMFhDSWdQeUJ0YjJSMWJHVXVaWGh3YjNKMGN5QTZJSHQ5WEc0cEtUdGNibHh1ZEhKNUlIdGNiaUFnY21WblpXNWxjbUYwYjNKU2RXNTBhVzFsSUQwZ2NuVnVkR2x0WlR0Y2JuMGdZMkYwWTJnZ0tHRmpZMmxrWlc1MFlXeFRkSEpwWTNSTmIyUmxLU0I3WEc0Z0lDOHZJRlJvYVhNZ2JXOWtkV3hsSUhOb2IzVnNaQ0J1YjNRZ1ltVWdjblZ1Ym1sdVp5QnBiaUJ6ZEhKcFkzUWdiVzlrWlN3Z2MyOGdkR2hsSUdGaWIzWmxYRzRnSUM4dklHRnpjMmxuYm0xbGJuUWdjMmh2ZFd4a0lHRnNkMkY1Y3lCM2IzSnJJSFZ1YkdWemN5QnpiMjFsZEdocGJtY2dhWE1nYldselkyOXVabWxuZFhKbFpDNGdTblZ6ZEZ4dUlDQXZMeUJwYmlCallYTmxJSEoxYm5ScGJXVXVhbk1nWVdOamFXUmxiblJoYkd4NUlISjFibk1nYVc0Z2MzUnlhV04wSUcxdlpHVXNJSGRsSUdOaGJpQmxjMk5oY0dWY2JpQWdMeThnYzNSeWFXTjBJRzF2WkdVZ2RYTnBibWNnWVNCbmJHOWlZV3dnUm5WdVkzUnBiMjRnWTJGc2JDNGdWR2hwY3lCamIzVnNaQ0JqYjI1alpXbDJZV0pzZVNCbVlXbHNYRzRnSUM4dklHbG1JR0VnUTI5dWRHVnVkQ0JUWldOMWNtbDBlU0JRYjJ4cFkza2dabTl5WW1sa2N5QjFjMmx1WnlCR2RXNWpkR2x2Yml3Z1luVjBJR2x1SUhSb1lYUWdZMkZ6WlZ4dUlDQXZMeUIwYUdVZ2NISnZjR1Z5SUhOdmJIVjBhVzl1SUdseklIUnZJR1pwZUNCMGFHVWdZV05qYVdSbGJuUmhiQ0J6ZEhKcFkzUWdiVzlrWlNCd2NtOWliR1Z0TGlCSlpseHVJQ0F2THlCNWIzVW5kbVVnYldselkyOXVabWxuZFhKbFpDQjViM1Z5SUdKMWJtUnNaWElnZEc4Z1ptOXlZMlVnYzNSeWFXTjBJRzF2WkdVZ1lXNWtJR0Z3Y0d4cFpXUWdZVnh1SUNBdkx5QkRVMUFnZEc4Z1ptOXlZbWxrSUVaMWJtTjBhVzl1TENCaGJtUWdlVzkxSjNKbElHNXZkQ0IzYVd4c2FXNW5JSFJ2SUdacGVDQmxhWFJvWlhJZ2IyWWdkR2h2YzJWY2JpQWdMeThnY0hKdllteGxiWE1zSUhCc1pXRnpaU0JrWlhSaGFXd2dlVzkxY2lCMWJtbHhkV1VnY0hKbFpHbGpZVzFsYm5RZ2FXNGdZU0JIYVhSSWRXSWdhWE56ZFdVdVhHNGdJRVoxYm1OMGFXOXVLRndpY2x3aUxDQmNJbkpsWjJWdVpYSmhkRzl5VW5WdWRHbHRaU0E5SUhKY0lpa29jblZ1ZEdsdFpTazdYRzU5WEc0aUxDSmpiMjV6ZENCeVpXZGxibVZ5WVhSdmNsSjFiblJwYldVZ1BTQnlaWEYxYVhKbEtGd2ljbVZuWlc1bGNtRjBiM0l0Y25WdWRHbHRaVndpS1R0Y2NseHVYSEpjYm1OdmJuTjBJSFJ2Y0d4cGJtVWdQU0JrYjJOMWJXVnVkQzV4ZFdWeWVWTmxiR1ZqZEc5eUtGd2lMbTFsYm5WY0lpazdYSEpjYm1OdmJuTjBJRzF2WW1sc1pVMWxiblVnUFNCa2IyTjFiV1Z1ZEM1blpYUkZiR1Z0Wlc1MFFubEpaQ2hjSW0xdlltbHNaVTFsYm5WY0lpazdYSEpjYm1OdmJuTjBJR05zYjNObFFuUnVJRDBnWkc5amRXMWxiblF1WjJWMFJXeGxiV1Z1ZEVKNVNXUW9YQ0pqYkc5elpVSjBibHdpS1R0Y2NseHVZMjl1YzNRZ1luVnlaMlZ5SUQwZ1pHOWpkVzFsYm5RdVoyVjBSV3hsYldWdWRFSjVTV1FvWENKaWRYSm5aWEpjSWlrN1hISmNibU52Ym5OMElHMXZZbWxzWlV4cGMzUWdQU0JrYjJOMWJXVnVkQzVuWlhSRmJHVnRaVzUwUW5sSlpDaGNJbTF2WW1sc1pVeHBjM1JjSWlrN1hISmNibU52Ym5OMElITmxaVTF2Y21VZ1BTQmtiMk4xYldWdWRDNW5aWFJGYkdWdFpXNTBRbmxKWkNoY0luTmxaVTF2Y21WY0lpazdYSEpjYm1OdmJuTjBJR0ZqWTI5eVpHVnZiaUE5SUdSdlkzVnRaVzUwTG1kbGRFVnNaVzFsYm5SQ2VVbGtLRndpWVdOamIzSmtaVzl1WENJcE8xeHlYRzVqYjI1emRDQnlaV0ZrVFc5eVpURWdQU0JrYjJOMWJXVnVkQzVuWlhSRmJHVnRaVzUwUW5sSlpDaGNJbkpsWVdSTmIzSmxNVndpS1R0Y2NseHVZMjl1YzNRZ2JHbHpkRVpwY25OMElEMGdaRzlqZFcxbGJuUXVaMlYwUld4bGJXVnVkRUo1U1dRb1hDSnNhWE4wUm1seWMzUmNJaWs3WEhKY2JtTnZibk4wSUhSbGVIUkdhWEp6ZENBOUlHUnZZM1Z0Wlc1MExtZGxkRVZzWlcxbGJuUkNlVWxrS0Z3aWRHVjRkRVpwY25OMFhDSXBPMXh5WEc1amIyNXpkQ0IwWlhoMFUyVmpiMjVrSUQwZ1pHOWpkVzFsYm5RdVoyVjBSV3hsYldWdWRFSjVTV1FvWENKMFpYaDBVMlZqYjI1a1hDSXBPMXh5WEc1c1pYUWdZMjkxYm5SbGNpQTlJRE03WEhKY2JteGxkQ0J5WVdselpYSWdQU0F6TzF4eVhHNWpiMjV6ZENCd2NtOWtkV04wY3lBOUlGdGNjbHh1SUNCN1hISmNiaUFnSUNCemNtTTZJRndpYVcxbkx6RXVJRWx1Wkc5dmNpNXFjR2RjSWl4Y2NseHVJQ0FnSUhOMVluUnBkR3hsT2lCY0lrbHVaRzl2Y2lCbGJtVnlaM2tnYzJWeWRtbGpaWE5jSWl4Y2NseHVJQ0FnSUhSbGVIUTZYSEpjYmlBZ0lDQWdJRndpVjJVZ2FHVnNjR1ZrSUVsdVpHOXZjaUJsYm1WeVoza2djMlZ5ZG1salpYTWdkRzhnWjNKbFlYUjVJSE5wYlhCc2FXWjVJSFJvWldseUlHTmhjMlVnYldGdVlXZGxiV1Z1ZENCemVYTjBaVzB1TGk1Y0lseHlYRzRnSUgwc1hISmNiaUFnZTF4eVhHNGdJQ0FnYzNKak9pQmNJbWx0Wnk4eUxpQkNhWEprYVdVdWFuQm5YQ0lzWEhKY2JpQWdJQ0J6ZFdKMGFYUnNaVG9nWENKQ2FYSmthV1VnUjI5c1pDQlViM1Z5YzF3aUxGeHlYRzRnSUNBZ2RHVjRkRHBjY2x4dUlDQWdJQ0FnWENKWFpTQm9aV3h3WldRZ1FtbHlaSGtnUjI5c1ppQlViM1Z5Y3lCMGJ5QnpkR0Y1SUhKbGJHVjJaV0Z1ZENCdmJpQmhiaUJwYm1Oc2NtVmhjMmx1WjJ4NUlHTnZiWEJsZEdsMGFYWmxJRzFoY210bGRDNHVMbHdpWEhKY2JpQWdmU3hjY2x4dUlDQjdYSEpjYmlBZ0lDQnpjbU02SUZ3aWFXMW5Mek11SUU1dmQxZG9aWEpsTG1wd1oxd2lMRnh5WEc0Z0lDQWdjM1ZpZEdsMGJHVTZJRndpVG05M1YyaGxjbVZjSWl4Y2NseHVJQ0FnSUhSbGVIUTZYSEpjYmlBZ0lDQWdJRndpVjJVZ1luVnBiSFFnWVNCeVpXTnZiVzFsYm1SaGRHbHZibk1nWVhCd0lHWnZjaUJ3Wlc5d2JHVWdkMjl5YTJsdVp5QnBiaUJqY21WaGRHbDJaU0JwYm1SMWMzUnlhV1Z6TGk0dVhDSmNjbHh1SUNCOUxGeHlYRzRnSUh0Y2NseHVJQ0FnSUhOeVl6b2dYQ0pwYldjdk5DNGdSbmx1WkdseGMzWmhhbkJsYmk1cWNHZGNJaXhjY2x4dUlDQWdJSE4xWW5ScGRHeGxPaUJjSWtaNWJtUnBjWE4yWVdwd1pXNWNJaXhjY2x4dUlDQWdJSFJsZUhRNlhISmNiaUFnSUNBZ0lGd2lWMlVnWTNKbFlYUmxaQ0JoYmlCaGNIQWdkR2hoZENCb1pXeHdaV1FnWTNWemRHOXRaWEp6SUdacGJtUWdaMmxtZEhNZ1lXMXZibWNnYlc5eVpTQjBhR0Z1SURJNU1EQXdNREFnYVhSbGJYTXVMaTVjSWx4eVhHNGdJSDBzWEhKY2JpQWdlMXh5WEc0Z0lDQWdjM0pqT2lCY0ltbHRaeTgxTGlCQ2VYUm9hblZzTG1wd1oxd2lMRnh5WEc0Z0lDQWdjM1ZpZEdsMGJHVTZJRndpUW5sMGFHcDFiRndpTEZ4eVhHNGdJQ0FnZEdWNGREcGNjbHh1SUNBZ0lDQWdYQ0pYWlNCamNtVmhkR1ZrSUhScGNtVWdabUZ6YUdsdmJpQm1iM0lnZEdobElHbHVZM0psWVhOcGJtZHNlU0JsWjJGc2FYUmhjbWxoYmlCallYSWdiV0ZwYm5ScGJtRmpaU0J0WVhKclpYUXVMaTVjSWx4eVhHNGdJSDBzWEhKY2JpQWdlMXh5WEc0Z0lDQWdjM0pqT2lCY0ltbHRaeTgyTGlCVWFXTnJhVzR1YW5CblhDSXNYSEpjYmlBZ0lDQnpkV0owYVhSc1pUb2dYQ0pVYVdOcmFXNWNJaXhjY2x4dUlDQWdJSFJsZUhRNlhISmNiaUFnSUNBZ0lGd2lWMlVnYVc1MlpXNTBaV1FnWVNCMGFXMWxJSEpsY0c5eWRHbHVaeUJ6ZVhOMFpXMGdabTl5SUhCbGIzQnNaU0IzYUc4Z2FHRjBaU0IwYVcxbElIUnlZV05yYVc1bkxpNHVYQ0pjY2x4dUlDQjlMRnh5WEc0Z0lIdGNjbHh1SUNBZ0lITnlZem9nWENKcGJXY3ZOeTRnVldKbGNtMWxaSE11YW5CblhDSXNYSEpjYmlBZ0lDQnpkV0owYVhSc1pUb2dYQ0pWWW1WeWJXVmtjMXdpTEZ4eVhHNGdJQ0FnZEdWNGREcGNjbHh1SUNBZ0lDQWdYQ0pYWlNCamNtVmhkR1ZrSUdGdUlHRndjQ0IwYUdGMElHaGxiSEJsWkNCamRYTjBiMjFsY25NZ1ptbHVaQ0JuYVdaMGN5QmhiVzl1WnlCdGIzSmxJSFJvWVc0Z01qa3dNREF3TUNCcGRHVnRjeTR1TGx3aVhISmNiaUFnZlN4Y2NseHVJQ0I3WEhKY2JpQWdJQ0J6Y21NNklGd2lhVzFuTHpndUlGYkRwSE4wZEhKaFptbHJJRU5oYkdOMWJHRjBiM0l1YW5CblhDSXNYSEpjYmlBZ0lDQnpkV0owYVhSc1pUb2dYQ0pXdzZSemRIUnlZV1pwYXlCRFlXeGpkV3hoZEc5eVhDSXNYSEpjYmlBZ0lDQjBaWGgwT2x4eVhHNGdJQ0FnSUNCY0lsZGxJR055WldGMFpXUWdkR2x5WlNCbVlYTm9hVzl1SUdadmNpQjBhR1VnYVc1amNtVmhjMmx1WjJ4NUlHVm5ZV3hwZEdGeWFXRnVJR05oY2lCdFlXbHVkR2x1WVdObElHMWhjbXRsZEM0dUxsd2lYSEpjYmlBZ2ZTeGNjbHh1SUNCN1hISmNiaUFnSUNCemNtTTZJRndpYVcxbkx6a3VJRlJ5dzZSdWFXNW5jM0JoY25SdVpYSXVhbkJuWENJc1hISmNiaUFnSUNCemRXSjBhWFJzWlRvZ1hDSlVjc09rYm1sdVozTndZWEowYm1WeVhDSXNYSEpjYmlBZ0lDQjBaWGgwT2x4eVhHNGdJQ0FnSUNCY0lsZGxJR2x1ZG1WdWRHVmtJR0VnZEdsdFpTQnlaWEJ2Y25ScGJtY2djM2x6ZEdWdElHWnZjaUJ3Wlc5d2JHVWdkMmh2SUdoaGRHVWdkR2x0WlNCMGNtRmphMmx1Wnk0dUxsd2lYSEpjYmlBZ2ZWeHlYRzVkTzF4eVhHNWNjbHh1Wkc5amRXMWxiblF1WVdSa1JYWmxiblJNYVhOMFpXNWxjaWhjSW5OamNtOXNiRndpTENBb0tTQTlQaUI3WEhKY2JpQWdhV1lnS0hkcGJtUnZkeTV3WVdkbFdVOW1abk5sZENBOElIUnZjR3hwYm1VdVkyeHBaVzUwU0dWcFoyaDBLU0I3WEhKY2JpQWdJQ0IwYjNCc2FXNWxMbU5zWVhOelRHbHpkQzV5WlcxdmRtVW9YQ0ptYVhobFpGd2lLVHRjY2x4dUlDQjlJR1ZzYzJVZ2UxeHlYRzRnSUNBZ2RHOXdiR2x1WlM1amJHRnpjMHhwYzNRdVlXUmtLRndpWm1sNFpXUmNJaWs3WEhKY2JpQWdmVnh5WEc1OUtUdGNjbHh1WEhKY2JtSjFjbWRsY2k1dmJtTnNhV05ySUQwZ1pTQTlQaUI3WEhKY2JpQWdaUzV3Y21WMlpXNTBSR1ZtWVhWc2RDZ3BPMXh5WEc0Z0lHMXZZbWxzWlUxbGJuVXVZMnhoYzNOTWFYTjBMblJ2WjJkc1pTaGNJbWhwWkdWY0lpazdYSEpjYm4wN1hISmNibHh5WEc1amJHOXpaVUowYmk1dmJtTnNhV05ySUQwZ1pTQTlQaUI3WEhKY2JpQWdaUzV3Y21WMlpXNTBSR1ZtWVhWc2RDZ3BPMXh5WEc0Z0lHMXZZbWxzWlUxbGJuVXVZMnhoYzNOTWFYTjBMblJ2WjJkc1pTaGNJbWhwWkdWY0lpazdYSEpjYm4wN1hISmNibHh5WEc1dGIySnBiR1ZNYVhOMExtOXVZMnhwWTJzZ1BTQW9LU0E5UGlCN1hISmNiaUFnYlc5aWFXeGxUV1Z1ZFM1amJHRnpjMHhwYzNRdWRHOW5aMnhsS0Z3aWFHbGtaVndpS1R0Y2NseHVmVHRjY2x4dVhISmNibUZqWTI5eVpHVnZiaTVoWkdSRmRtVnVkRXhwYzNSbGJtVnlLRndpWTJ4cFkydGNJaXdnWlNBOVBpQjdYSEpjYmlBZ2JHVjBJSFJoY21kbGRDQTlJR1V1ZEdGeVoyVjBPMXh5WEc0Z0lHTnZibk4wSUd4cGMzUWdQU0JrYjJOMWJXVnVkQzVuWlhSRmJHVnRaVzUwYzBKNVEyeGhjM05PWVcxbEtGd2lhRzkzTFhkbExXUnZYMTkwWVdKc1pYUXRhWFJsYlZ3aUtUdGNjbHh1SUNCc1pYUWdZWEp5SUQwZ1d5NHVMbXhwYzNSZE8xeHlYRzRnSUdsbUlDaDBZWEpuWlhRdVkyeGhjM05NYVhOMExtTnZiblJoYVc1ektDZHphRzkzSnlrcElIdGNjbHh1SUNBZ0lIUmhjbWRsZEM1amJHRnpjMHhwYzNRdWRHOW5aMnhsS0Z3aWMyaHZkMXdpS1R0Y2NseHVJQ0I5SUdWc2MyVWdlMXh5WEc0Z0lDQWdZWEp5TG0xaGNDaHBJRDArSUdrdVkyeGhjM05NYVhOMExuSmxiVzkyWlNoY0luTm9iM2RjSWlrcE8xeHlYRzRnSUNBZ2RHRnlaMlYwTG1Oc1lYTnpUR2x6ZEM1MGIyZG5iR1VvWENKemFHOTNYQ0lwTzF4eVhHNGdJSDFjY2x4dWZTazdYSEpjYmx4eVhHNXlaV0ZrVFc5eVpURXViMjVqYkdsamF5QTlJR1VnUFQ0Z2UxeHlYRzRnSUdVdWNISmxkbVZ1ZEVSbFptRjFiSFFvS1R0Y2NseHVJQ0JzYVhOMFJtbHljM1F1WTJ4aGMzTk1hWE4wTG1Ga1pDaGNJbTF2Y21WY0lpazdYSEpjYmlBZ2RHVjRkRVpwY25OMExtTnNZWE56VEdsemRDNWhaR1FvWENKdGIzSmxYQ0lwTzF4eVhHNTlPMXh5WEc1Y2NseHVjbVZoWkUxdmNtVXlMbTl1WTJ4cFkyc2dQU0JsSUQwK0lIdGNjbHh1SUNCbExuQnlaWFpsYm5SRVpXWmhkV3gwS0NrN1hISmNiaUFnZEdWNGRGTmxZMjl1WkM1amJHRnpjMHhwYzNRdVlXUmtLRndpYlc5eVpWd2lLVHRjY2x4dWZUdGNjbHh1WEhKY2JtTnZibk4wSUhKbGJtUmxjbEJ5YjJSMVkzUnpJRDBnYVhSbGJTQTlQaUI3WEhKY2JpQWdjbVYwZFhKdUlHQThaR2wySUdOc1lYTnpQVndpWTI5c0xURXlJR052YkMxdFpDMDJJR052YkMxc1p5MDBYQ0krWEhKY2JpQWdQR1JwZGlCamJHRnpjejFjSW5CeWIycGxZM1J6WDE5allYSmtYQ0krWEhKY2JpQWdJQ0E4YVcxbklITnlZejFjSWlSN2FYUmxiUzV6Y21OOVhDSWdZV3gwUFZ3aWJXRnphMXdpUGx4eVhHNGdJQ0FnUEdScGRpQmpiR0Z6Y3oxY0luQnliMnBsWTNSelgxOXBibVp2WENJK1hISmNiaUFnSUNBZ0lEeG9OQ0JqYkdGemN6MWNJbkJ5YjJwbFkzUnpYMTl6ZFdKMGFYUnNaVndpUGlSN2FYUmxiUzV6ZFdKMGFYUnNaWDA4TDJnMFBseHlYRzRnSUNBZ0lDQThjQ0JqYkdGemN6MWNJbkJ5YjJwbFkzUnpYMTkwWlhoMFhDSStKSHRwZEdWdExuUmxlSFI5UEM5d1BseHlYRzRnSUNBZ1BDOWthWFkrWEhKY2JpQWdQQzlrYVhZK1hISmNiand2WkdsMlBtQTdYSEpjYm4wN1hISmNibHh5WEc1c1pYUWdjbVZ1WkdWeVUyVmpkR2x2YmlBOUlIQnliMnBsWTNSelJHRjBZU0E5UGlCN1hISmNiaUFnWTI5dWMzUWdjSEp2YW1WamRITWdQU0J3Y205cVpXTjBjMFJoZEdFdWJXRndLR1ZzWlcxbGJuUWdQVDRnY21WdVpHVnlVSEp2WkhWamRITW9aV3hsYldWdWRDa3BPMXh5WEc0Z0lHUnZZM1Z0Wlc1MExtZGxkRVZzWlcxbGJuUkNlVWxrS0Z3aWNISnZhbVZqZEhOU1pXNWtaWEpjSWlrdWFXNXVaWEpJVkUxTUlEMGdjSEp2YW1WamRITXVhbTlwYmloY0lsd2lLVHRjY2x4dWZUdGNjbHh1WEhKY2JuTmxaVTF2Y21VdWIyNWpiR2xqYXlBOUlHVWdQVDRnZTF4eVhHNGdJR1V1Y0hKbGRtVnVkRVJsWm1GMWJIUW9LVHRjY2x4dUlDQmpiM1Z1ZEdWeUlDczlJSEpoYVhObGNqdGNjbHh1SUNCeVpXNWtaWEpUWldOMGFXOXVLSEJ5YjJSMVkzUnpMbk5zYVdObEtEQXNJR052ZFc1MFpYSXBLVHRjY2x4dWZUdGNjbHh1WEhKY2JuZHBibVJ2ZHk1aFpHUkZkbVZ1ZEV4cGMzUmxibVZ5S0Z3aVJFOU5RMjl1ZEdWdWRFeHZZV1JsWkZ3aUxDQW9LU0E5UGlCN1hISmNiaUFnWTI5dWMzUWdkMmwwWkdoRGIzVnVkR1Z5SUQwZ1lYTjVibU1nS0NrZ1BUNGdlMXh5WEc0Z0lDQWdjM2RwZEdOb0lDaDBjblZsS1NCN1hISmNiaUFnSUNBZ0lHTmhjMlVnWkc5amRXMWxiblF1Wkc5amRXMWxiblJGYkdWdFpXNTBMbU5zYVdWdWRGZHBaSFJvSUQ0Z056WTRPbHh5WEc0Z0lDQWdJQ0FnSUdOdmRXNTBaWElnUFNBNU8xeHlYRzRnSUNBZ0lDQWdJR0p5WldGck8xeHlYRzRnSUNBZ0lDQmpZWE5sSUdSdlkzVnRaVzUwTG1SdlkzVnRaVzUwUld4bGJXVnVkQzVqYkdsbGJuUlhhV1IwYUNBK0lEUXhORHBjY2x4dUlDQWdJQ0FnSUNCamIzVnVkR1Z5SUQwZ05EdGNjbHh1SUNBZ0lDQWdJQ0J5WVdselpYSWdQU0EwTzF4eVhHNGdJQ0FnSUNBZ0lHSnlaV0ZyTzF4eVhHNGdJQ0FnSUNCa1pXWmhkV3gwT2x4eVhHNGdJQ0FnSUNBZ0lHTnZkVzUwWlhJZ1BTQXpPMXh5WEc0Z0lDQWdJQ0FnSUhKaGFYTmxjaUE5SURNN1hISmNiaUFnSUNBZ0lDQWdZbkpsWVdzN1hISmNiaUFnSUNCOVhISmNiaUFnZlR0Y2NseHVJQ0IzYVhSa2FFTnZkVzUwWlhJb0tUdGNjbHh1SUNCeVpXNWtaWEpUWldOMGFXOXVLSEJ5YjJSMVkzUnpMbk5zYVdObEtEQXNJR052ZFc1MFpYSXBLVHRjY2x4dWZTazdYSEpjYmlKZGZRPT0ifQ==
