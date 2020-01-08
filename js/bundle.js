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
}; // accordeon.addEventListener("click", e => {
//   let target = e.target;
//   const list = document.getElementsByClassName("how-we-do__tablet-item");
//   let arr = [...list];
//   if (target.classList.contains('show')) {
//     target.classList.toggle("show");
//   } else {
//     arr.map(i => i.classList.remove("show"));
//     target.classList.toggle("show");
//   }
// });
// cards.addEventListener("mouseover", e => {
//   const target = e.target;
//   const childs = cards.children;
//   if(target.classList.contains('methods__card')) {
//     for (let i=0, child; child = childs[i]; i++) {
//       child.classList.remove('active')
//     }
//     target.classList.add('active');
//   } else return
// });


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
}; // readMore2.onclick = () => {
//   textSecond.classList.toggle("more");
//   readMore2.classList.toggle("hidden");
//   readLess2.classList.toggle("hidden");
// };
// readLess2.onclick = () => {
//   textSecond.classList.toggle("more");
//   readMore2.classList.toggle("hidden");
//   readLess2.classList.toggle("hidden");
// };


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

//# sourceMappingURL=data:application/json;charset=utf8;base64,eyJ2ZXJzaW9uIjozLCJzb3VyY2VzIjpbIm5vZGVfbW9kdWxlcy9icm93c2VyLXBhY2svX3ByZWx1ZGUuanMiLCJub2RlX21vZHVsZXMvcmVnZW5lcmF0b3ItcnVudGltZS9ydW50aW1lLmpzIiwicHJvamVjdHMvd2hpdGVwb3J0LXNpdGUvc3JjL2pzL2FwcC5qcyJdLCJuYW1lcyI6W10sIm1hcHBpbmdzIjoiQUFBQTtBQ0FBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBOzs7O0FDdHRCQSxJQUFNLGtCQUFrQixHQUFHLE9BQU8sQ0FBQyxxQkFBRCxDQUFsQzs7QUFFQSxJQUFNLE9BQU8sR0FBRyxRQUFRLENBQUMsYUFBVCxDQUF1QixPQUF2QixDQUFoQjtBQUNBLElBQU0sVUFBVSxHQUFHLFFBQVEsQ0FBQyxjQUFULENBQXdCLFlBQXhCLENBQW5CO0FBQ0EsSUFBTSxRQUFRLEdBQUcsUUFBUSxDQUFDLGNBQVQsQ0FBd0IsVUFBeEIsQ0FBakI7QUFDQSxJQUFNLE1BQU0sR0FBRyxRQUFRLENBQUMsY0FBVCxDQUF3QixRQUF4QixDQUFmO0FBQ0EsSUFBTSxVQUFVLEdBQUcsUUFBUSxDQUFDLGNBQVQsQ0FBd0IsWUFBeEIsQ0FBbkI7QUFDQSxJQUFNLE9BQU8sR0FBRyxRQUFRLENBQUMsY0FBVCxDQUF3QixTQUF4QixDQUFoQjtBQUNBLElBQU0sU0FBUyxHQUFHLFFBQVEsQ0FBQyxjQUFULENBQXdCLFdBQXhCLENBQWxCO0FBQ0EsSUFBTSxTQUFTLEdBQUcsUUFBUSxDQUFDLGNBQVQsQ0FBd0IsV0FBeEIsQ0FBbEI7QUFDQSxJQUFNLFNBQVMsR0FBRyxRQUFRLENBQUMsY0FBVCxDQUF3QixXQUF4QixDQUFsQjtBQUNBLElBQU0sU0FBUyxHQUFHLFFBQVEsQ0FBQyxjQUFULENBQXdCLFdBQXhCLENBQWxCO0FBQ0EsSUFBTSxTQUFTLEdBQUcsUUFBUSxDQUFDLGNBQVQsQ0FBd0IsV0FBeEIsQ0FBbEI7QUFDQSxJQUFNLFNBQVMsR0FBRyxRQUFRLENBQUMsY0FBVCxDQUF3QixXQUF4QixDQUFsQjtBQUNBLElBQU0sU0FBUyxHQUFHLFFBQVEsQ0FBQyxjQUFULENBQXdCLFdBQXhCLENBQWxCO0FBQ0EsSUFBTSxVQUFVLEdBQUcsUUFBUSxDQUFDLGNBQVQsQ0FBd0IsWUFBeEIsQ0FBbkI7QUFDQSxJQUFNLEtBQUssR0FBRyxRQUFRLENBQUMsY0FBVCxDQUF3QixPQUF4QixDQUFkO0FBQ0EsSUFBTSxVQUFVLEdBQUcsUUFBUSxDQUFDLGNBQVQsQ0FBd0IsWUFBeEIsQ0FBbkI7QUFDQSxJQUFJLE9BQU8sR0FBRyxDQUFkO0FBQ0EsSUFBSSxNQUFNLEdBQUcsQ0FBYjtBQUNBLElBQU0sUUFBUSxHQUFHLENBQ2Y7QUFDRSxFQUFBLEdBQUcsRUFBRSxtQkFEUDtBQUVFLEVBQUEsUUFBUSxFQUFFLHdCQUZaO0FBR0UsRUFBQSxJQUFJLEVBQ0Y7QUFKSixDQURlLEVBT2Y7QUFDRSxFQUFBLEdBQUcsRUFBRSxtQkFEUDtBQUVFLEVBQUEsUUFBUSxFQUFFLG1CQUZaO0FBR0UsRUFBQSxJQUFJLEVBQ0Y7QUFKSixDQVBlLEVBYWY7QUFDRSxFQUFBLEdBQUcsRUFBRSxxQkFEUDtBQUVFLEVBQUEsUUFBUSxFQUFFLFVBRlo7QUFHRSxFQUFBLElBQUksRUFDRjtBQUpKLENBYmUsRUFtQmY7QUFDRSxFQUFBLEdBQUcsRUFBRSwwQkFEUDtBQUVFLEVBQUEsUUFBUSxFQUFFLGVBRlo7QUFHRSxFQUFBLElBQUksRUFDRjtBQUpKLENBbkJlLEVBeUJmO0FBQ0UsRUFBQSxHQUFHLEVBQUUsb0JBRFA7QUFFRSxFQUFBLFFBQVEsRUFBRSxTQUZaO0FBR0UsRUFBQSxJQUFJLEVBQ0Y7QUFKSixDQXpCZSxFQStCZjtBQUNFLEVBQUEsR0FBRyxFQUFFLG1CQURQO0FBRUUsRUFBQSxRQUFRLEVBQUUsUUFGWjtBQUdFLEVBQUEsSUFBSSxFQUNGO0FBSkosQ0EvQmUsRUFxQ2Y7QUFDRSxFQUFBLEdBQUcsRUFBRSxxQkFEUDtBQUVFLEVBQUEsUUFBUSxFQUFFLFVBRlo7QUFHRSxFQUFBLElBQUksRUFDRjtBQUpKLENBckNlLEVBMkNmO0FBQ0UsRUFBQSxHQUFHLEVBQUUsa0NBRFA7QUFFRSxFQUFBLFFBQVEsRUFBRSx1QkFGWjtBQUdFLEVBQUEsSUFBSSxFQUNGO0FBSkosQ0EzQ2UsRUFpRGY7QUFDRSxFQUFBLEdBQUcsRUFBRSw0QkFEUDtBQUVFLEVBQUEsUUFBUSxFQUFFLGlCQUZaO0FBR0UsRUFBQSxJQUFJLEVBQ0Y7QUFKSixDQWpEZSxDQUFqQjtBQXlEQSxRQUFRLENBQUMsZ0JBQVQsQ0FBMEIsUUFBMUIsRUFBb0MsWUFBTTtBQUN4QyxNQUFJLE1BQU0sQ0FBQyxXQUFQLEdBQXFCLE9BQU8sQ0FBQyxZQUFqQyxFQUErQztBQUM3QyxJQUFBLE9BQU8sQ0FBQyxTQUFSLENBQWtCLE1BQWxCLENBQXlCLE9BQXpCO0FBQ0QsR0FGRCxNQUVPO0FBQ0wsSUFBQSxPQUFPLENBQUMsU0FBUixDQUFrQixHQUFsQixDQUFzQixPQUF0QjtBQUNEO0FBQ0YsQ0FORDs7QUFRQSxNQUFNLENBQUMsT0FBUCxHQUFpQixVQUFBLENBQUMsRUFBSTtBQUNwQixFQUFBLENBQUMsQ0FBQyxjQUFGO0FBQ0EsRUFBQSxVQUFVLENBQUMsU0FBWCxDQUFxQixNQUFyQixDQUE0QixNQUE1QjtBQUNELENBSEQ7O0FBS0EsUUFBUSxDQUFDLE9BQVQsR0FBbUIsVUFBQSxDQUFDLEVBQUk7QUFDdEIsRUFBQSxDQUFDLENBQUMsY0FBRjtBQUNBLEVBQUEsVUFBVSxDQUFDLFNBQVgsQ0FBcUIsTUFBckIsQ0FBNEIsTUFBNUI7QUFDRCxDQUhEOztBQUtBLFVBQVUsQ0FBQyxPQUFYLEdBQXFCLFlBQU07QUFDekIsRUFBQSxVQUFVLENBQUMsU0FBWCxDQUFxQixNQUFyQixDQUE0QixNQUE1QjtBQUNELENBRkQsQyxDQUlBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFFQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTs7O0FBRUEsU0FBUyxDQUFDLE9BQVYsR0FBb0IsWUFBTTtBQUN4QixFQUFBLFNBQVMsQ0FBQyxTQUFWLENBQW9CLE1BQXBCLENBQTJCLE1BQTNCO0FBQ0EsRUFBQSxTQUFTLENBQUMsU0FBVixDQUFvQixNQUFwQixDQUEyQixNQUEzQjtBQUNBLEVBQUEsU0FBUyxDQUFDLFNBQVYsQ0FBb0IsTUFBcEIsQ0FBMkIsUUFBM0I7QUFDQSxFQUFBLFNBQVMsQ0FBQyxTQUFWLENBQW9CLE1BQXBCLENBQTJCLFFBQTNCO0FBQ0QsQ0FMRDs7QUFPQSxTQUFTLENBQUMsT0FBVixHQUFvQixZQUFNO0FBQ3hCLEVBQUEsU0FBUyxDQUFDLFNBQVYsQ0FBb0IsTUFBcEIsQ0FBMkIsTUFBM0I7QUFDQSxFQUFBLFNBQVMsQ0FBQyxTQUFWLENBQW9CLE1BQXBCLENBQTJCLE1BQTNCO0FBQ0EsRUFBQSxTQUFTLENBQUMsU0FBVixDQUFvQixNQUFwQixDQUEyQixRQUEzQjtBQUNBLEVBQUEsU0FBUyxDQUFDLFNBQVYsQ0FBb0IsTUFBcEIsQ0FBMkIsUUFBM0I7QUFDRCxDQUxELEMsQ0FPQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBRUE7QUFDQTtBQUNBO0FBQ0E7QUFDQTs7O0FBRUEsSUFBTSxjQUFjLEdBQUcsU0FBakIsY0FBaUIsQ0FBQSxJQUFJLEVBQUk7QUFDN0IsbUpBRWlELElBQUksQ0FBQyxHQUZ0RCxnSEFJcUMsSUFBSSxDQUFDLFFBSjFDLHNEQUtnQyxJQUFJLENBQUMsSUFMckM7QUFTRCxDQVZEOztBQVlBLElBQUksYUFBYSxHQUFHLFNBQWhCLGFBQWdCLENBQUEsWUFBWSxFQUFJO0FBQ2xDLE1BQU0sUUFBUSxHQUFHLFlBQVksQ0FBQyxHQUFiLENBQWlCLFVBQUEsT0FBTztBQUFBLFdBQUksY0FBYyxDQUFDLE9BQUQsQ0FBbEI7QUFBQSxHQUF4QixDQUFqQjtBQUNBLEVBQUEsUUFBUSxDQUFDLGNBQVQsQ0FBd0IsZ0JBQXhCLEVBQTBDLFNBQTFDLEdBQXNELFFBQVEsQ0FBQyxJQUFULENBQWMsRUFBZCxDQUF0RDtBQUNELENBSEQ7O0FBS0EsT0FBTyxDQUFDLE9BQVIsR0FBa0IsVUFBQSxDQUFDLEVBQUk7QUFDckIsRUFBQSxDQUFDLENBQUMsY0FBRjtBQUNBLEVBQUEsT0FBTyxJQUFJLE1BQVg7QUFDQSxFQUFBLGFBQWEsQ0FBQyxRQUFRLENBQUMsS0FBVCxDQUFlLENBQWYsRUFBa0IsT0FBbEIsQ0FBRCxDQUFiO0FBQ0QsQ0FKRDs7QUFNQSxNQUFNLENBQUMsZ0JBQVAsQ0FBd0Isa0JBQXhCLEVBQTRDLFlBQU07QUFDaEQsTUFBTSxZQUFZLEdBQUcsU0FBZixZQUFlO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQSwwQkFDWCxJQURXO0FBQUEsNENBRVosUUFBUSxDQUFDLGVBQVQsQ0FBeUIsV0FBekIsR0FBdUMsR0FGM0IsdUJBS1osUUFBUSxDQUFDLGVBQVQsQ0FBeUIsV0FBekIsR0FBdUMsR0FMM0I7QUFBQTs7QUFBQTtBQUdmLFlBQUEsT0FBTyxHQUFHLENBQVY7QUFIZTs7QUFBQTtBQU1mLFlBQUEsT0FBTyxHQUFHLENBQVY7QUFDQSxZQUFBLE1BQU0sR0FBRyxDQUFUO0FBUGU7O0FBQUE7QUFVZixZQUFBLE9BQU8sR0FBRyxDQUFWO0FBQ0EsWUFBQSxNQUFNLEdBQUcsQ0FBVDtBQVhlOztBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBLEdBQXJCOztBQWVBLEVBQUEsWUFBWTtBQUNaLEVBQUEsYUFBYSxDQUFDLFFBQVEsQ0FBQyxLQUFULENBQWUsQ0FBZixFQUFrQixPQUFsQixDQUFELENBQWI7QUFDRCxDQWxCRCIsImZpbGUiOiJidW5kbGUuanMiLCJzb3VyY2VzQ29udGVudCI6WyIoZnVuY3Rpb24oKXtmdW5jdGlvbiByKGUsbix0KXtmdW5jdGlvbiBvKGksZil7aWYoIW5baV0pe2lmKCFlW2ldKXt2YXIgYz1cImZ1bmN0aW9uXCI9PXR5cGVvZiByZXF1aXJlJiZyZXF1aXJlO2lmKCFmJiZjKXJldHVybiBjKGksITApO2lmKHUpcmV0dXJuIHUoaSwhMCk7dmFyIGE9bmV3IEVycm9yKFwiQ2Fubm90IGZpbmQgbW9kdWxlICdcIitpK1wiJ1wiKTt0aHJvdyBhLmNvZGU9XCJNT0RVTEVfTk9UX0ZPVU5EXCIsYX12YXIgcD1uW2ldPXtleHBvcnRzOnt9fTtlW2ldWzBdLmNhbGwocC5leHBvcnRzLGZ1bmN0aW9uKHIpe3ZhciBuPWVbaV1bMV1bcl07cmV0dXJuIG8obnx8cil9LHAscC5leHBvcnRzLHIsZSxuLHQpfXJldHVybiBuW2ldLmV4cG9ydHN9Zm9yKHZhciB1PVwiZnVuY3Rpb25cIj09dHlwZW9mIHJlcXVpcmUmJnJlcXVpcmUsaT0wO2k8dC5sZW5ndGg7aSsrKW8odFtpXSk7cmV0dXJuIG99cmV0dXJuIHJ9KSgpIiwiLyoqXG4gKiBDb3B5cmlnaHQgKGMpIDIwMTQtcHJlc2VudCwgRmFjZWJvb2ssIEluYy5cbiAqXG4gKiBUaGlzIHNvdXJjZSBjb2RlIGlzIGxpY2Vuc2VkIHVuZGVyIHRoZSBNSVQgbGljZW5zZSBmb3VuZCBpbiB0aGVcbiAqIExJQ0VOU0UgZmlsZSBpbiB0aGUgcm9vdCBkaXJlY3Rvcnkgb2YgdGhpcyBzb3VyY2UgdHJlZS5cbiAqL1xuXG52YXIgcnVudGltZSA9IChmdW5jdGlvbiAoZXhwb3J0cykge1xuICBcInVzZSBzdHJpY3RcIjtcblxuICB2YXIgT3AgPSBPYmplY3QucHJvdG90eXBlO1xuICB2YXIgaGFzT3duID0gT3AuaGFzT3duUHJvcGVydHk7XG4gIHZhciB1bmRlZmluZWQ7IC8vIE1vcmUgY29tcHJlc3NpYmxlIHRoYW4gdm9pZCAwLlxuICB2YXIgJFN5bWJvbCA9IHR5cGVvZiBTeW1ib2wgPT09IFwiZnVuY3Rpb25cIiA/IFN5bWJvbCA6IHt9O1xuICB2YXIgaXRlcmF0b3JTeW1ib2wgPSAkU3ltYm9sLml0ZXJhdG9yIHx8IFwiQEBpdGVyYXRvclwiO1xuICB2YXIgYXN5bmNJdGVyYXRvclN5bWJvbCA9ICRTeW1ib2wuYXN5bmNJdGVyYXRvciB8fCBcIkBAYXN5bmNJdGVyYXRvclwiO1xuICB2YXIgdG9TdHJpbmdUYWdTeW1ib2wgPSAkU3ltYm9sLnRvU3RyaW5nVGFnIHx8IFwiQEB0b1N0cmluZ1RhZ1wiO1xuXG4gIGZ1bmN0aW9uIHdyYXAoaW5uZXJGbiwgb3V0ZXJGbiwgc2VsZiwgdHJ5TG9jc0xpc3QpIHtcbiAgICAvLyBJZiBvdXRlckZuIHByb3ZpZGVkIGFuZCBvdXRlckZuLnByb3RvdHlwZSBpcyBhIEdlbmVyYXRvciwgdGhlbiBvdXRlckZuLnByb3RvdHlwZSBpbnN0YW5jZW9mIEdlbmVyYXRvci5cbiAgICB2YXIgcHJvdG9HZW5lcmF0b3IgPSBvdXRlckZuICYmIG91dGVyRm4ucHJvdG90eXBlIGluc3RhbmNlb2YgR2VuZXJhdG9yID8gb3V0ZXJGbiA6IEdlbmVyYXRvcjtcbiAgICB2YXIgZ2VuZXJhdG9yID0gT2JqZWN0LmNyZWF0ZShwcm90b0dlbmVyYXRvci5wcm90b3R5cGUpO1xuICAgIHZhciBjb250ZXh0ID0gbmV3IENvbnRleHQodHJ5TG9jc0xpc3QgfHwgW10pO1xuXG4gICAgLy8gVGhlIC5faW52b2tlIG1ldGhvZCB1bmlmaWVzIHRoZSBpbXBsZW1lbnRhdGlvbnMgb2YgdGhlIC5uZXh0LFxuICAgIC8vIC50aHJvdywgYW5kIC5yZXR1cm4gbWV0aG9kcy5cbiAgICBnZW5lcmF0b3IuX2ludm9rZSA9IG1ha2VJbnZva2VNZXRob2QoaW5uZXJGbiwgc2VsZiwgY29udGV4dCk7XG5cbiAgICByZXR1cm4gZ2VuZXJhdG9yO1xuICB9XG4gIGV4cG9ydHMud3JhcCA9IHdyYXA7XG5cbiAgLy8gVHJ5L2NhdGNoIGhlbHBlciB0byBtaW5pbWl6ZSBkZW9wdGltaXphdGlvbnMuIFJldHVybnMgYSBjb21wbGV0aW9uXG4gIC8vIHJlY29yZCBsaWtlIGNvbnRleHQudHJ5RW50cmllc1tpXS5jb21wbGV0aW9uLiBUaGlzIGludGVyZmFjZSBjb3VsZFxuICAvLyBoYXZlIGJlZW4gKGFuZCB3YXMgcHJldmlvdXNseSkgZGVzaWduZWQgdG8gdGFrZSBhIGNsb3N1cmUgdG8gYmVcbiAgLy8gaW52b2tlZCB3aXRob3V0IGFyZ3VtZW50cywgYnV0IGluIGFsbCB0aGUgY2FzZXMgd2UgY2FyZSBhYm91dCB3ZVxuICAvLyBhbHJlYWR5IGhhdmUgYW4gZXhpc3RpbmcgbWV0aG9kIHdlIHdhbnQgdG8gY2FsbCwgc28gdGhlcmUncyBubyBuZWVkXG4gIC8vIHRvIGNyZWF0ZSBhIG5ldyBmdW5jdGlvbiBvYmplY3QuIFdlIGNhbiBldmVuIGdldCBhd2F5IHdpdGggYXNzdW1pbmdcbiAgLy8gdGhlIG1ldGhvZCB0YWtlcyBleGFjdGx5IG9uZSBhcmd1bWVudCwgc2luY2UgdGhhdCBoYXBwZW5zIHRvIGJlIHRydWVcbiAgLy8gaW4gZXZlcnkgY2FzZSwgc28gd2UgZG9uJ3QgaGF2ZSB0byB0b3VjaCB0aGUgYXJndW1lbnRzIG9iamVjdC4gVGhlXG4gIC8vIG9ubHkgYWRkaXRpb25hbCBhbGxvY2F0aW9uIHJlcXVpcmVkIGlzIHRoZSBjb21wbGV0aW9uIHJlY29yZCwgd2hpY2hcbiAgLy8gaGFzIGEgc3RhYmxlIHNoYXBlIGFuZCBzbyBob3BlZnVsbHkgc2hvdWxkIGJlIGNoZWFwIHRvIGFsbG9jYXRlLlxuICBmdW5jdGlvbiB0cnlDYXRjaChmbiwgb2JqLCBhcmcpIHtcbiAgICB0cnkge1xuICAgICAgcmV0dXJuIHsgdHlwZTogXCJub3JtYWxcIiwgYXJnOiBmbi5jYWxsKG9iaiwgYXJnKSB9O1xuICAgIH0gY2F0Y2ggKGVycikge1xuICAgICAgcmV0dXJuIHsgdHlwZTogXCJ0aHJvd1wiLCBhcmc6IGVyciB9O1xuICAgIH1cbiAgfVxuXG4gIHZhciBHZW5TdGF0ZVN1c3BlbmRlZFN0YXJ0ID0gXCJzdXNwZW5kZWRTdGFydFwiO1xuICB2YXIgR2VuU3RhdGVTdXNwZW5kZWRZaWVsZCA9IFwic3VzcGVuZGVkWWllbGRcIjtcbiAgdmFyIEdlblN0YXRlRXhlY3V0aW5nID0gXCJleGVjdXRpbmdcIjtcbiAgdmFyIEdlblN0YXRlQ29tcGxldGVkID0gXCJjb21wbGV0ZWRcIjtcblxuICAvLyBSZXR1cm5pbmcgdGhpcyBvYmplY3QgZnJvbSB0aGUgaW5uZXJGbiBoYXMgdGhlIHNhbWUgZWZmZWN0IGFzXG4gIC8vIGJyZWFraW5nIG91dCBvZiB0aGUgZGlzcGF0Y2ggc3dpdGNoIHN0YXRlbWVudC5cbiAgdmFyIENvbnRpbnVlU2VudGluZWwgPSB7fTtcblxuICAvLyBEdW1teSBjb25zdHJ1Y3RvciBmdW5jdGlvbnMgdGhhdCB3ZSB1c2UgYXMgdGhlIC5jb25zdHJ1Y3RvciBhbmRcbiAgLy8gLmNvbnN0cnVjdG9yLnByb3RvdHlwZSBwcm9wZXJ0aWVzIGZvciBmdW5jdGlvbnMgdGhhdCByZXR1cm4gR2VuZXJhdG9yXG4gIC8vIG9iamVjdHMuIEZvciBmdWxsIHNwZWMgY29tcGxpYW5jZSwgeW91IG1heSB3aXNoIHRvIGNvbmZpZ3VyZSB5b3VyXG4gIC8vIG1pbmlmaWVyIG5vdCB0byBtYW5nbGUgdGhlIG5hbWVzIG9mIHRoZXNlIHR3byBmdW5jdGlvbnMuXG4gIGZ1bmN0aW9uIEdlbmVyYXRvcigpIHt9XG4gIGZ1bmN0aW9uIEdlbmVyYXRvckZ1bmN0aW9uKCkge31cbiAgZnVuY3Rpb24gR2VuZXJhdG9yRnVuY3Rpb25Qcm90b3R5cGUoKSB7fVxuXG4gIC8vIFRoaXMgaXMgYSBwb2x5ZmlsbCBmb3IgJUl0ZXJhdG9yUHJvdG90eXBlJSBmb3IgZW52aXJvbm1lbnRzIHRoYXRcbiAgLy8gZG9uJ3QgbmF0aXZlbHkgc3VwcG9ydCBpdC5cbiAgdmFyIEl0ZXJhdG9yUHJvdG90eXBlID0ge307XG4gIEl0ZXJhdG9yUHJvdG90eXBlW2l0ZXJhdG9yU3ltYm9sXSA9IGZ1bmN0aW9uICgpIHtcbiAgICByZXR1cm4gdGhpcztcbiAgfTtcblxuICB2YXIgZ2V0UHJvdG8gPSBPYmplY3QuZ2V0UHJvdG90eXBlT2Y7XG4gIHZhciBOYXRpdmVJdGVyYXRvclByb3RvdHlwZSA9IGdldFByb3RvICYmIGdldFByb3RvKGdldFByb3RvKHZhbHVlcyhbXSkpKTtcbiAgaWYgKE5hdGl2ZUl0ZXJhdG9yUHJvdG90eXBlICYmXG4gICAgICBOYXRpdmVJdGVyYXRvclByb3RvdHlwZSAhPT0gT3AgJiZcbiAgICAgIGhhc093bi5jYWxsKE5hdGl2ZUl0ZXJhdG9yUHJvdG90eXBlLCBpdGVyYXRvclN5bWJvbCkpIHtcbiAgICAvLyBUaGlzIGVudmlyb25tZW50IGhhcyBhIG5hdGl2ZSAlSXRlcmF0b3JQcm90b3R5cGUlOyB1c2UgaXQgaW5zdGVhZFxuICAgIC8vIG9mIHRoZSBwb2x5ZmlsbC5cbiAgICBJdGVyYXRvclByb3RvdHlwZSA9IE5hdGl2ZUl0ZXJhdG9yUHJvdG90eXBlO1xuICB9XG5cbiAgdmFyIEdwID0gR2VuZXJhdG9yRnVuY3Rpb25Qcm90b3R5cGUucHJvdG90eXBlID1cbiAgICBHZW5lcmF0b3IucHJvdG90eXBlID0gT2JqZWN0LmNyZWF0ZShJdGVyYXRvclByb3RvdHlwZSk7XG4gIEdlbmVyYXRvckZ1bmN0aW9uLnByb3RvdHlwZSA9IEdwLmNvbnN0cnVjdG9yID0gR2VuZXJhdG9yRnVuY3Rpb25Qcm90b3R5cGU7XG4gIEdlbmVyYXRvckZ1bmN0aW9uUHJvdG90eXBlLmNvbnN0cnVjdG9yID0gR2VuZXJhdG9yRnVuY3Rpb247XG4gIEdlbmVyYXRvckZ1bmN0aW9uUHJvdG90eXBlW3RvU3RyaW5nVGFnU3ltYm9sXSA9XG4gICAgR2VuZXJhdG9yRnVuY3Rpb24uZGlzcGxheU5hbWUgPSBcIkdlbmVyYXRvckZ1bmN0aW9uXCI7XG5cbiAgLy8gSGVscGVyIGZvciBkZWZpbmluZyB0aGUgLm5leHQsIC50aHJvdywgYW5kIC5yZXR1cm4gbWV0aG9kcyBvZiB0aGVcbiAgLy8gSXRlcmF0b3IgaW50ZXJmYWNlIGluIHRlcm1zIG9mIGEgc2luZ2xlIC5faW52b2tlIG1ldGhvZC5cbiAgZnVuY3Rpb24gZGVmaW5lSXRlcmF0b3JNZXRob2RzKHByb3RvdHlwZSkge1xuICAgIFtcIm5leHRcIiwgXCJ0aHJvd1wiLCBcInJldHVyblwiXS5mb3JFYWNoKGZ1bmN0aW9uKG1ldGhvZCkge1xuICAgICAgcHJvdG90eXBlW21ldGhvZF0gPSBmdW5jdGlvbihhcmcpIHtcbiAgICAgICAgcmV0dXJuIHRoaXMuX2ludm9rZShtZXRob2QsIGFyZyk7XG4gICAgICB9O1xuICAgIH0pO1xuICB9XG5cbiAgZXhwb3J0cy5pc0dlbmVyYXRvckZ1bmN0aW9uID0gZnVuY3Rpb24oZ2VuRnVuKSB7XG4gICAgdmFyIGN0b3IgPSB0eXBlb2YgZ2VuRnVuID09PSBcImZ1bmN0aW9uXCIgJiYgZ2VuRnVuLmNvbnN0cnVjdG9yO1xuICAgIHJldHVybiBjdG9yXG4gICAgICA/IGN0b3IgPT09IEdlbmVyYXRvckZ1bmN0aW9uIHx8XG4gICAgICAgIC8vIEZvciB0aGUgbmF0aXZlIEdlbmVyYXRvckZ1bmN0aW9uIGNvbnN0cnVjdG9yLCB0aGUgYmVzdCB3ZSBjYW5cbiAgICAgICAgLy8gZG8gaXMgdG8gY2hlY2sgaXRzIC5uYW1lIHByb3BlcnR5LlxuICAgICAgICAoY3Rvci5kaXNwbGF5TmFtZSB8fCBjdG9yLm5hbWUpID09PSBcIkdlbmVyYXRvckZ1bmN0aW9uXCJcbiAgICAgIDogZmFsc2U7XG4gIH07XG5cbiAgZXhwb3J0cy5tYXJrID0gZnVuY3Rpb24oZ2VuRnVuKSB7XG4gICAgaWYgKE9iamVjdC5zZXRQcm90b3R5cGVPZikge1xuICAgICAgT2JqZWN0LnNldFByb3RvdHlwZU9mKGdlbkZ1biwgR2VuZXJhdG9yRnVuY3Rpb25Qcm90b3R5cGUpO1xuICAgIH0gZWxzZSB7XG4gICAgICBnZW5GdW4uX19wcm90b19fID0gR2VuZXJhdG9yRnVuY3Rpb25Qcm90b3R5cGU7XG4gICAgICBpZiAoISh0b1N0cmluZ1RhZ1N5bWJvbCBpbiBnZW5GdW4pKSB7XG4gICAgICAgIGdlbkZ1blt0b1N0cmluZ1RhZ1N5bWJvbF0gPSBcIkdlbmVyYXRvckZ1bmN0aW9uXCI7XG4gICAgICB9XG4gICAgfVxuICAgIGdlbkZ1bi5wcm90b3R5cGUgPSBPYmplY3QuY3JlYXRlKEdwKTtcbiAgICByZXR1cm4gZ2VuRnVuO1xuICB9O1xuXG4gIC8vIFdpdGhpbiB0aGUgYm9keSBvZiBhbnkgYXN5bmMgZnVuY3Rpb24sIGBhd2FpdCB4YCBpcyB0cmFuc2Zvcm1lZCB0b1xuICAvLyBgeWllbGQgcmVnZW5lcmF0b3JSdW50aW1lLmF3cmFwKHgpYCwgc28gdGhhdCB0aGUgcnVudGltZSBjYW4gdGVzdFxuICAvLyBgaGFzT3duLmNhbGwodmFsdWUsIFwiX19hd2FpdFwiKWAgdG8gZGV0ZXJtaW5lIGlmIHRoZSB5aWVsZGVkIHZhbHVlIGlzXG4gIC8vIG1lYW50IHRvIGJlIGF3YWl0ZWQuXG4gIGV4cG9ydHMuYXdyYXAgPSBmdW5jdGlvbihhcmcpIHtcbiAgICByZXR1cm4geyBfX2F3YWl0OiBhcmcgfTtcbiAgfTtcblxuICBmdW5jdGlvbiBBc3luY0l0ZXJhdG9yKGdlbmVyYXRvcikge1xuICAgIGZ1bmN0aW9uIGludm9rZShtZXRob2QsIGFyZywgcmVzb2x2ZSwgcmVqZWN0KSB7XG4gICAgICB2YXIgcmVjb3JkID0gdHJ5Q2F0Y2goZ2VuZXJhdG9yW21ldGhvZF0sIGdlbmVyYXRvciwgYXJnKTtcbiAgICAgIGlmIChyZWNvcmQudHlwZSA9PT0gXCJ0aHJvd1wiKSB7XG4gICAgICAgIHJlamVjdChyZWNvcmQuYXJnKTtcbiAgICAgIH0gZWxzZSB7XG4gICAgICAgIHZhciByZXN1bHQgPSByZWNvcmQuYXJnO1xuICAgICAgICB2YXIgdmFsdWUgPSByZXN1bHQudmFsdWU7XG4gICAgICAgIGlmICh2YWx1ZSAmJlxuICAgICAgICAgICAgdHlwZW9mIHZhbHVlID09PSBcIm9iamVjdFwiICYmXG4gICAgICAgICAgICBoYXNPd24uY2FsbCh2YWx1ZSwgXCJfX2F3YWl0XCIpKSB7XG4gICAgICAgICAgcmV0dXJuIFByb21pc2UucmVzb2x2ZSh2YWx1ZS5fX2F3YWl0KS50aGVuKGZ1bmN0aW9uKHZhbHVlKSB7XG4gICAgICAgICAgICBpbnZva2UoXCJuZXh0XCIsIHZhbHVlLCByZXNvbHZlLCByZWplY3QpO1xuICAgICAgICAgIH0sIGZ1bmN0aW9uKGVycikge1xuICAgICAgICAgICAgaW52b2tlKFwidGhyb3dcIiwgZXJyLCByZXNvbHZlLCByZWplY3QpO1xuICAgICAgICAgIH0pO1xuICAgICAgICB9XG5cbiAgICAgICAgcmV0dXJuIFByb21pc2UucmVzb2x2ZSh2YWx1ZSkudGhlbihmdW5jdGlvbih1bndyYXBwZWQpIHtcbiAgICAgICAgICAvLyBXaGVuIGEgeWllbGRlZCBQcm9taXNlIGlzIHJlc29sdmVkLCBpdHMgZmluYWwgdmFsdWUgYmVjb21lc1xuICAgICAgICAgIC8vIHRoZSAudmFsdWUgb2YgdGhlIFByb21pc2U8e3ZhbHVlLGRvbmV9PiByZXN1bHQgZm9yIHRoZVxuICAgICAgICAgIC8vIGN1cnJlbnQgaXRlcmF0aW9uLlxuICAgICAgICAgIHJlc3VsdC52YWx1ZSA9IHVud3JhcHBlZDtcbiAgICAgICAgICByZXNvbHZlKHJlc3VsdCk7XG4gICAgICAgIH0sIGZ1bmN0aW9uKGVycm9yKSB7XG4gICAgICAgICAgLy8gSWYgYSByZWplY3RlZCBQcm9taXNlIHdhcyB5aWVsZGVkLCB0aHJvdyB0aGUgcmVqZWN0aW9uIGJhY2tcbiAgICAgICAgICAvLyBpbnRvIHRoZSBhc3luYyBnZW5lcmF0b3IgZnVuY3Rpb24gc28gaXQgY2FuIGJlIGhhbmRsZWQgdGhlcmUuXG4gICAgICAgICAgcmV0dXJuIGludm9rZShcInRocm93XCIsIGVycm9yLCByZXNvbHZlLCByZWplY3QpO1xuICAgICAgICB9KTtcbiAgICAgIH1cbiAgICB9XG5cbiAgICB2YXIgcHJldmlvdXNQcm9taXNlO1xuXG4gICAgZnVuY3Rpb24gZW5xdWV1ZShtZXRob2QsIGFyZykge1xuICAgICAgZnVuY3Rpb24gY2FsbEludm9rZVdpdGhNZXRob2RBbmRBcmcoKSB7XG4gICAgICAgIHJldHVybiBuZXcgUHJvbWlzZShmdW5jdGlvbihyZXNvbHZlLCByZWplY3QpIHtcbiAgICAgICAgICBpbnZva2UobWV0aG9kLCBhcmcsIHJlc29sdmUsIHJlamVjdCk7XG4gICAgICAgIH0pO1xuICAgICAgfVxuXG4gICAgICByZXR1cm4gcHJldmlvdXNQcm9taXNlID1cbiAgICAgICAgLy8gSWYgZW5xdWV1ZSBoYXMgYmVlbiBjYWxsZWQgYmVmb3JlLCB0aGVuIHdlIHdhbnQgdG8gd2FpdCB1bnRpbFxuICAgICAgICAvLyBhbGwgcHJldmlvdXMgUHJvbWlzZXMgaGF2ZSBiZWVuIHJlc29sdmVkIGJlZm9yZSBjYWxsaW5nIGludm9rZSxcbiAgICAgICAgLy8gc28gdGhhdCByZXN1bHRzIGFyZSBhbHdheXMgZGVsaXZlcmVkIGluIHRoZSBjb3JyZWN0IG9yZGVyLiBJZlxuICAgICAgICAvLyBlbnF1ZXVlIGhhcyBub3QgYmVlbiBjYWxsZWQgYmVmb3JlLCB0aGVuIGl0IGlzIGltcG9ydGFudCB0b1xuICAgICAgICAvLyBjYWxsIGludm9rZSBpbW1lZGlhdGVseSwgd2l0aG91dCB3YWl0aW5nIG9uIGEgY2FsbGJhY2sgdG8gZmlyZSxcbiAgICAgICAgLy8gc28gdGhhdCB0aGUgYXN5bmMgZ2VuZXJhdG9yIGZ1bmN0aW9uIGhhcyB0aGUgb3Bwb3J0dW5pdHkgdG8gZG9cbiAgICAgICAgLy8gYW55IG5lY2Vzc2FyeSBzZXR1cCBpbiBhIHByZWRpY3RhYmxlIHdheS4gVGhpcyBwcmVkaWN0YWJpbGl0eVxuICAgICAgICAvLyBpcyB3aHkgdGhlIFByb21pc2UgY29uc3RydWN0b3Igc3luY2hyb25vdXNseSBpbnZva2VzIGl0c1xuICAgICAgICAvLyBleGVjdXRvciBjYWxsYmFjaywgYW5kIHdoeSBhc3luYyBmdW5jdGlvbnMgc3luY2hyb25vdXNseVxuICAgICAgICAvLyBleGVjdXRlIGNvZGUgYmVmb3JlIHRoZSBmaXJzdCBhd2FpdC4gU2luY2Ugd2UgaW1wbGVtZW50IHNpbXBsZVxuICAgICAgICAvLyBhc3luYyBmdW5jdGlvbnMgaW4gdGVybXMgb2YgYXN5bmMgZ2VuZXJhdG9ycywgaXQgaXMgZXNwZWNpYWxseVxuICAgICAgICAvLyBpbXBvcnRhbnQgdG8gZ2V0IHRoaXMgcmlnaHQsIGV2ZW4gdGhvdWdoIGl0IHJlcXVpcmVzIGNhcmUuXG4gICAgICAgIHByZXZpb3VzUHJvbWlzZSA/IHByZXZpb3VzUHJvbWlzZS50aGVuKFxuICAgICAgICAgIGNhbGxJbnZva2VXaXRoTWV0aG9kQW5kQXJnLFxuICAgICAgICAgIC8vIEF2b2lkIHByb3BhZ2F0aW5nIGZhaWx1cmVzIHRvIFByb21pc2VzIHJldHVybmVkIGJ5IGxhdGVyXG4gICAgICAgICAgLy8gaW52b2NhdGlvbnMgb2YgdGhlIGl0ZXJhdG9yLlxuICAgICAgICAgIGNhbGxJbnZva2VXaXRoTWV0aG9kQW5kQXJnXG4gICAgICAgICkgOiBjYWxsSW52b2tlV2l0aE1ldGhvZEFuZEFyZygpO1xuICAgIH1cblxuICAgIC8vIERlZmluZSB0aGUgdW5pZmllZCBoZWxwZXIgbWV0aG9kIHRoYXQgaXMgdXNlZCB0byBpbXBsZW1lbnQgLm5leHQsXG4gICAgLy8gLnRocm93LCBhbmQgLnJldHVybiAoc2VlIGRlZmluZUl0ZXJhdG9yTWV0aG9kcykuXG4gICAgdGhpcy5faW52b2tlID0gZW5xdWV1ZTtcbiAgfVxuXG4gIGRlZmluZUl0ZXJhdG9yTWV0aG9kcyhBc3luY0l0ZXJhdG9yLnByb3RvdHlwZSk7XG4gIEFzeW5jSXRlcmF0b3IucHJvdG90eXBlW2FzeW5jSXRlcmF0b3JTeW1ib2xdID0gZnVuY3Rpb24gKCkge1xuICAgIHJldHVybiB0aGlzO1xuICB9O1xuICBleHBvcnRzLkFzeW5jSXRlcmF0b3IgPSBBc3luY0l0ZXJhdG9yO1xuXG4gIC8vIE5vdGUgdGhhdCBzaW1wbGUgYXN5bmMgZnVuY3Rpb25zIGFyZSBpbXBsZW1lbnRlZCBvbiB0b3Agb2ZcbiAgLy8gQXN5bmNJdGVyYXRvciBvYmplY3RzOyB0aGV5IGp1c3QgcmV0dXJuIGEgUHJvbWlzZSBmb3IgdGhlIHZhbHVlIG9mXG4gIC8vIHRoZSBmaW5hbCByZXN1bHQgcHJvZHVjZWQgYnkgdGhlIGl0ZXJhdG9yLlxuICBleHBvcnRzLmFzeW5jID0gZnVuY3Rpb24oaW5uZXJGbiwgb3V0ZXJGbiwgc2VsZiwgdHJ5TG9jc0xpc3QpIHtcbiAgICB2YXIgaXRlciA9IG5ldyBBc3luY0l0ZXJhdG9yKFxuICAgICAgd3JhcChpbm5lckZuLCBvdXRlckZuLCBzZWxmLCB0cnlMb2NzTGlzdClcbiAgICApO1xuXG4gICAgcmV0dXJuIGV4cG9ydHMuaXNHZW5lcmF0b3JGdW5jdGlvbihvdXRlckZuKVxuICAgICAgPyBpdGVyIC8vIElmIG91dGVyRm4gaXMgYSBnZW5lcmF0b3IsIHJldHVybiB0aGUgZnVsbCBpdGVyYXRvci5cbiAgICAgIDogaXRlci5uZXh0KCkudGhlbihmdW5jdGlvbihyZXN1bHQpIHtcbiAgICAgICAgICByZXR1cm4gcmVzdWx0LmRvbmUgPyByZXN1bHQudmFsdWUgOiBpdGVyLm5leHQoKTtcbiAgICAgICAgfSk7XG4gIH07XG5cbiAgZnVuY3Rpb24gbWFrZUludm9rZU1ldGhvZChpbm5lckZuLCBzZWxmLCBjb250ZXh0KSB7XG4gICAgdmFyIHN0YXRlID0gR2VuU3RhdGVTdXNwZW5kZWRTdGFydDtcblxuICAgIHJldHVybiBmdW5jdGlvbiBpbnZva2UobWV0aG9kLCBhcmcpIHtcbiAgICAgIGlmIChzdGF0ZSA9PT0gR2VuU3RhdGVFeGVjdXRpbmcpIHtcbiAgICAgICAgdGhyb3cgbmV3IEVycm9yKFwiR2VuZXJhdG9yIGlzIGFscmVhZHkgcnVubmluZ1wiKTtcbiAgICAgIH1cblxuICAgICAgaWYgKHN0YXRlID09PSBHZW5TdGF0ZUNvbXBsZXRlZCkge1xuICAgICAgICBpZiAobWV0aG9kID09PSBcInRocm93XCIpIHtcbiAgICAgICAgICB0aHJvdyBhcmc7XG4gICAgICAgIH1cblxuICAgICAgICAvLyBCZSBmb3JnaXZpbmcsIHBlciAyNS4zLjMuMy4zIG9mIHRoZSBzcGVjOlxuICAgICAgICAvLyBodHRwczovL3Blb3BsZS5tb3ppbGxhLm9yZy9+am9yZW5kb3JmZi9lczYtZHJhZnQuaHRtbCNzZWMtZ2VuZXJhdG9ycmVzdW1lXG4gICAgICAgIHJldHVybiBkb25lUmVzdWx0KCk7XG4gICAgICB9XG5cbiAgICAgIGNvbnRleHQubWV0aG9kID0gbWV0aG9kO1xuICAgICAgY29udGV4dC5hcmcgPSBhcmc7XG5cbiAgICAgIHdoaWxlICh0cnVlKSB7XG4gICAgICAgIHZhciBkZWxlZ2F0ZSA9IGNvbnRleHQuZGVsZWdhdGU7XG4gICAgICAgIGlmIChkZWxlZ2F0ZSkge1xuICAgICAgICAgIHZhciBkZWxlZ2F0ZVJlc3VsdCA9IG1heWJlSW52b2tlRGVsZWdhdGUoZGVsZWdhdGUsIGNvbnRleHQpO1xuICAgICAgICAgIGlmIChkZWxlZ2F0ZVJlc3VsdCkge1xuICAgICAgICAgICAgaWYgKGRlbGVnYXRlUmVzdWx0ID09PSBDb250aW51ZVNlbnRpbmVsKSBjb250aW51ZTtcbiAgICAgICAgICAgIHJldHVybiBkZWxlZ2F0ZVJlc3VsdDtcbiAgICAgICAgICB9XG4gICAgICAgIH1cblxuICAgICAgICBpZiAoY29udGV4dC5tZXRob2QgPT09IFwibmV4dFwiKSB7XG4gICAgICAgICAgLy8gU2V0dGluZyBjb250ZXh0Ll9zZW50IGZvciBsZWdhY3kgc3VwcG9ydCBvZiBCYWJlbCdzXG4gICAgICAgICAgLy8gZnVuY3Rpb24uc2VudCBpbXBsZW1lbnRhdGlvbi5cbiAgICAgICAgICBjb250ZXh0LnNlbnQgPSBjb250ZXh0Ll9zZW50ID0gY29udGV4dC5hcmc7XG5cbiAgICAgICAgfSBlbHNlIGlmIChjb250ZXh0Lm1ldGhvZCA9PT0gXCJ0aHJvd1wiKSB7XG4gICAgICAgICAgaWYgKHN0YXRlID09PSBHZW5TdGF0ZVN1c3BlbmRlZFN0YXJ0KSB7XG4gICAgICAgICAgICBzdGF0ZSA9IEdlblN0YXRlQ29tcGxldGVkO1xuICAgICAgICAgICAgdGhyb3cgY29udGV4dC5hcmc7XG4gICAgICAgICAgfVxuXG4gICAgICAgICAgY29udGV4dC5kaXNwYXRjaEV4Y2VwdGlvbihjb250ZXh0LmFyZyk7XG5cbiAgICAgICAgfSBlbHNlIGlmIChjb250ZXh0Lm1ldGhvZCA9PT0gXCJyZXR1cm5cIikge1xuICAgICAgICAgIGNvbnRleHQuYWJydXB0KFwicmV0dXJuXCIsIGNvbnRleHQuYXJnKTtcbiAgICAgICAgfVxuXG4gICAgICAgIHN0YXRlID0gR2VuU3RhdGVFeGVjdXRpbmc7XG5cbiAgICAgICAgdmFyIHJlY29yZCA9IHRyeUNhdGNoKGlubmVyRm4sIHNlbGYsIGNvbnRleHQpO1xuICAgICAgICBpZiAocmVjb3JkLnR5cGUgPT09IFwibm9ybWFsXCIpIHtcbiAgICAgICAgICAvLyBJZiBhbiBleGNlcHRpb24gaXMgdGhyb3duIGZyb20gaW5uZXJGbiwgd2UgbGVhdmUgc3RhdGUgPT09XG4gICAgICAgICAgLy8gR2VuU3RhdGVFeGVjdXRpbmcgYW5kIGxvb3AgYmFjayBmb3IgYW5vdGhlciBpbnZvY2F0aW9uLlxuICAgICAgICAgIHN0YXRlID0gY29udGV4dC5kb25lXG4gICAgICAgICAgICA/IEdlblN0YXRlQ29tcGxldGVkXG4gICAgICAgICAgICA6IEdlblN0YXRlU3VzcGVuZGVkWWllbGQ7XG5cbiAgICAgICAgICBpZiAocmVjb3JkLmFyZyA9PT0gQ29udGludWVTZW50aW5lbCkge1xuICAgICAgICAgICAgY29udGludWU7XG4gICAgICAgICAgfVxuXG4gICAgICAgICAgcmV0dXJuIHtcbiAgICAgICAgICAgIHZhbHVlOiByZWNvcmQuYXJnLFxuICAgICAgICAgICAgZG9uZTogY29udGV4dC5kb25lXG4gICAgICAgICAgfTtcblxuICAgICAgICB9IGVsc2UgaWYgKHJlY29yZC50eXBlID09PSBcInRocm93XCIpIHtcbiAgICAgICAgICBzdGF0ZSA9IEdlblN0YXRlQ29tcGxldGVkO1xuICAgICAgICAgIC8vIERpc3BhdGNoIHRoZSBleGNlcHRpb24gYnkgbG9vcGluZyBiYWNrIGFyb3VuZCB0byB0aGVcbiAgICAgICAgICAvLyBjb250ZXh0LmRpc3BhdGNoRXhjZXB0aW9uKGNvbnRleHQuYXJnKSBjYWxsIGFib3ZlLlxuICAgICAgICAgIGNvbnRleHQubWV0aG9kID0gXCJ0aHJvd1wiO1xuICAgICAgICAgIGNvbnRleHQuYXJnID0gcmVjb3JkLmFyZztcbiAgICAgICAgfVxuICAgICAgfVxuICAgIH07XG4gIH1cblxuICAvLyBDYWxsIGRlbGVnYXRlLml0ZXJhdG9yW2NvbnRleHQubWV0aG9kXShjb250ZXh0LmFyZykgYW5kIGhhbmRsZSB0aGVcbiAgLy8gcmVzdWx0LCBlaXRoZXIgYnkgcmV0dXJuaW5nIGEgeyB2YWx1ZSwgZG9uZSB9IHJlc3VsdCBmcm9tIHRoZVxuICAvLyBkZWxlZ2F0ZSBpdGVyYXRvciwgb3IgYnkgbW9kaWZ5aW5nIGNvbnRleHQubWV0aG9kIGFuZCBjb250ZXh0LmFyZyxcbiAgLy8gc2V0dGluZyBjb250ZXh0LmRlbGVnYXRlIHRvIG51bGwsIGFuZCByZXR1cm5pbmcgdGhlIENvbnRpbnVlU2VudGluZWwuXG4gIGZ1bmN0aW9uIG1heWJlSW52b2tlRGVsZWdhdGUoZGVsZWdhdGUsIGNvbnRleHQpIHtcbiAgICB2YXIgbWV0aG9kID0gZGVsZWdhdGUuaXRlcmF0b3JbY29udGV4dC5tZXRob2RdO1xuICAgIGlmIChtZXRob2QgPT09IHVuZGVmaW5lZCkge1xuICAgICAgLy8gQSAudGhyb3cgb3IgLnJldHVybiB3aGVuIHRoZSBkZWxlZ2F0ZSBpdGVyYXRvciBoYXMgbm8gLnRocm93XG4gICAgICAvLyBtZXRob2QgYWx3YXlzIHRlcm1pbmF0ZXMgdGhlIHlpZWxkKiBsb29wLlxuICAgICAgY29udGV4dC5kZWxlZ2F0ZSA9IG51bGw7XG5cbiAgICAgIGlmIChjb250ZXh0Lm1ldGhvZCA9PT0gXCJ0aHJvd1wiKSB7XG4gICAgICAgIC8vIE5vdGU6IFtcInJldHVyblwiXSBtdXN0IGJlIHVzZWQgZm9yIEVTMyBwYXJzaW5nIGNvbXBhdGliaWxpdHkuXG4gICAgICAgIGlmIChkZWxlZ2F0ZS5pdGVyYXRvcltcInJldHVyblwiXSkge1xuICAgICAgICAgIC8vIElmIHRoZSBkZWxlZ2F0ZSBpdGVyYXRvciBoYXMgYSByZXR1cm4gbWV0aG9kLCBnaXZlIGl0IGFcbiAgICAgICAgICAvLyBjaGFuY2UgdG8gY2xlYW4gdXAuXG4gICAgICAgICAgY29udGV4dC5tZXRob2QgPSBcInJldHVyblwiO1xuICAgICAgICAgIGNvbnRleHQuYXJnID0gdW5kZWZpbmVkO1xuICAgICAgICAgIG1heWJlSW52b2tlRGVsZWdhdGUoZGVsZWdhdGUsIGNvbnRleHQpO1xuXG4gICAgICAgICAgaWYgKGNvbnRleHQubWV0aG9kID09PSBcInRocm93XCIpIHtcbiAgICAgICAgICAgIC8vIElmIG1heWJlSW52b2tlRGVsZWdhdGUoY29udGV4dCkgY2hhbmdlZCBjb250ZXh0Lm1ldGhvZCBmcm9tXG4gICAgICAgICAgICAvLyBcInJldHVyblwiIHRvIFwidGhyb3dcIiwgbGV0IHRoYXQgb3ZlcnJpZGUgdGhlIFR5cGVFcnJvciBiZWxvdy5cbiAgICAgICAgICAgIHJldHVybiBDb250aW51ZVNlbnRpbmVsO1xuICAgICAgICAgIH1cbiAgICAgICAgfVxuXG4gICAgICAgIGNvbnRleHQubWV0aG9kID0gXCJ0aHJvd1wiO1xuICAgICAgICBjb250ZXh0LmFyZyA9IG5ldyBUeXBlRXJyb3IoXG4gICAgICAgICAgXCJUaGUgaXRlcmF0b3IgZG9lcyBub3QgcHJvdmlkZSBhICd0aHJvdycgbWV0aG9kXCIpO1xuICAgICAgfVxuXG4gICAgICByZXR1cm4gQ29udGludWVTZW50aW5lbDtcbiAgICB9XG5cbiAgICB2YXIgcmVjb3JkID0gdHJ5Q2F0Y2gobWV0aG9kLCBkZWxlZ2F0ZS5pdGVyYXRvciwgY29udGV4dC5hcmcpO1xuXG4gICAgaWYgKHJlY29yZC50eXBlID09PSBcInRocm93XCIpIHtcbiAgICAgIGNvbnRleHQubWV0aG9kID0gXCJ0aHJvd1wiO1xuICAgICAgY29udGV4dC5hcmcgPSByZWNvcmQuYXJnO1xuICAgICAgY29udGV4dC5kZWxlZ2F0ZSA9IG51bGw7XG4gICAgICByZXR1cm4gQ29udGludWVTZW50aW5lbDtcbiAgICB9XG5cbiAgICB2YXIgaW5mbyA9IHJlY29yZC5hcmc7XG5cbiAgICBpZiAoISBpbmZvKSB7XG4gICAgICBjb250ZXh0Lm1ldGhvZCA9IFwidGhyb3dcIjtcbiAgICAgIGNvbnRleHQuYXJnID0gbmV3IFR5cGVFcnJvcihcIml0ZXJhdG9yIHJlc3VsdCBpcyBub3QgYW4gb2JqZWN0XCIpO1xuICAgICAgY29udGV4dC5kZWxlZ2F0ZSA9IG51bGw7XG4gICAgICByZXR1cm4gQ29udGludWVTZW50aW5lbDtcbiAgICB9XG5cbiAgICBpZiAoaW5mby5kb25lKSB7XG4gICAgICAvLyBBc3NpZ24gdGhlIHJlc3VsdCBvZiB0aGUgZmluaXNoZWQgZGVsZWdhdGUgdG8gdGhlIHRlbXBvcmFyeVxuICAgICAgLy8gdmFyaWFibGUgc3BlY2lmaWVkIGJ5IGRlbGVnYXRlLnJlc3VsdE5hbWUgKHNlZSBkZWxlZ2F0ZVlpZWxkKS5cbiAgICAgIGNvbnRleHRbZGVsZWdhdGUucmVzdWx0TmFtZV0gPSBpbmZvLnZhbHVlO1xuXG4gICAgICAvLyBSZXN1bWUgZXhlY3V0aW9uIGF0IHRoZSBkZXNpcmVkIGxvY2F0aW9uIChzZWUgZGVsZWdhdGVZaWVsZCkuXG4gICAgICBjb250ZXh0Lm5leHQgPSBkZWxlZ2F0ZS5uZXh0TG9jO1xuXG4gICAgICAvLyBJZiBjb250ZXh0Lm1ldGhvZCB3YXMgXCJ0aHJvd1wiIGJ1dCB0aGUgZGVsZWdhdGUgaGFuZGxlZCB0aGVcbiAgICAgIC8vIGV4Y2VwdGlvbiwgbGV0IHRoZSBvdXRlciBnZW5lcmF0b3IgcHJvY2VlZCBub3JtYWxseS4gSWZcbiAgICAgIC8vIGNvbnRleHQubWV0aG9kIHdhcyBcIm5leHRcIiwgZm9yZ2V0IGNvbnRleHQuYXJnIHNpbmNlIGl0IGhhcyBiZWVuXG4gICAgICAvLyBcImNvbnN1bWVkXCIgYnkgdGhlIGRlbGVnYXRlIGl0ZXJhdG9yLiBJZiBjb250ZXh0Lm1ldGhvZCB3YXNcbiAgICAgIC8vIFwicmV0dXJuXCIsIGFsbG93IHRoZSBvcmlnaW5hbCAucmV0dXJuIGNhbGwgdG8gY29udGludWUgaW4gdGhlXG4gICAgICAvLyBvdXRlciBnZW5lcmF0b3IuXG4gICAgICBpZiAoY29udGV4dC5tZXRob2QgIT09IFwicmV0dXJuXCIpIHtcbiAgICAgICAgY29udGV4dC5tZXRob2QgPSBcIm5leHRcIjtcbiAgICAgICAgY29udGV4dC5hcmcgPSB1bmRlZmluZWQ7XG4gICAgICB9XG5cbiAgICB9IGVsc2Uge1xuICAgICAgLy8gUmUteWllbGQgdGhlIHJlc3VsdCByZXR1cm5lZCBieSB0aGUgZGVsZWdhdGUgbWV0aG9kLlxuICAgICAgcmV0dXJuIGluZm87XG4gICAgfVxuXG4gICAgLy8gVGhlIGRlbGVnYXRlIGl0ZXJhdG9yIGlzIGZpbmlzaGVkLCBzbyBmb3JnZXQgaXQgYW5kIGNvbnRpbnVlIHdpdGhcbiAgICAvLyB0aGUgb3V0ZXIgZ2VuZXJhdG9yLlxuICAgIGNvbnRleHQuZGVsZWdhdGUgPSBudWxsO1xuICAgIHJldHVybiBDb250aW51ZVNlbnRpbmVsO1xuICB9XG5cbiAgLy8gRGVmaW5lIEdlbmVyYXRvci5wcm90b3R5cGUue25leHQsdGhyb3cscmV0dXJufSBpbiB0ZXJtcyBvZiB0aGVcbiAgLy8gdW5pZmllZCAuX2ludm9rZSBoZWxwZXIgbWV0aG9kLlxuICBkZWZpbmVJdGVyYXRvck1ldGhvZHMoR3ApO1xuXG4gIEdwW3RvU3RyaW5nVGFnU3ltYm9sXSA9IFwiR2VuZXJhdG9yXCI7XG5cbiAgLy8gQSBHZW5lcmF0b3Igc2hvdWxkIGFsd2F5cyByZXR1cm4gaXRzZWxmIGFzIHRoZSBpdGVyYXRvciBvYmplY3Qgd2hlbiB0aGVcbiAgLy8gQEBpdGVyYXRvciBmdW5jdGlvbiBpcyBjYWxsZWQgb24gaXQuIFNvbWUgYnJvd3NlcnMnIGltcGxlbWVudGF0aW9ucyBvZiB0aGVcbiAgLy8gaXRlcmF0b3IgcHJvdG90eXBlIGNoYWluIGluY29ycmVjdGx5IGltcGxlbWVudCB0aGlzLCBjYXVzaW5nIHRoZSBHZW5lcmF0b3JcbiAgLy8gb2JqZWN0IHRvIG5vdCBiZSByZXR1cm5lZCBmcm9tIHRoaXMgY2FsbC4gVGhpcyBlbnN1cmVzIHRoYXQgZG9lc24ndCBoYXBwZW4uXG4gIC8vIFNlZSBodHRwczovL2dpdGh1Yi5jb20vZmFjZWJvb2svcmVnZW5lcmF0b3IvaXNzdWVzLzI3NCBmb3IgbW9yZSBkZXRhaWxzLlxuICBHcFtpdGVyYXRvclN5bWJvbF0gPSBmdW5jdGlvbigpIHtcbiAgICByZXR1cm4gdGhpcztcbiAgfTtcblxuICBHcC50b1N0cmluZyA9IGZ1bmN0aW9uKCkge1xuICAgIHJldHVybiBcIltvYmplY3QgR2VuZXJhdG9yXVwiO1xuICB9O1xuXG4gIGZ1bmN0aW9uIHB1c2hUcnlFbnRyeShsb2NzKSB7XG4gICAgdmFyIGVudHJ5ID0geyB0cnlMb2M6IGxvY3NbMF0gfTtcblxuICAgIGlmICgxIGluIGxvY3MpIHtcbiAgICAgIGVudHJ5LmNhdGNoTG9jID0gbG9jc1sxXTtcbiAgICB9XG5cbiAgICBpZiAoMiBpbiBsb2NzKSB7XG4gICAgICBlbnRyeS5maW5hbGx5TG9jID0gbG9jc1syXTtcbiAgICAgIGVudHJ5LmFmdGVyTG9jID0gbG9jc1szXTtcbiAgICB9XG5cbiAgICB0aGlzLnRyeUVudHJpZXMucHVzaChlbnRyeSk7XG4gIH1cblxuICBmdW5jdGlvbiByZXNldFRyeUVudHJ5KGVudHJ5KSB7XG4gICAgdmFyIHJlY29yZCA9IGVudHJ5LmNvbXBsZXRpb24gfHwge307XG4gICAgcmVjb3JkLnR5cGUgPSBcIm5vcm1hbFwiO1xuICAgIGRlbGV0ZSByZWNvcmQuYXJnO1xuICAgIGVudHJ5LmNvbXBsZXRpb24gPSByZWNvcmQ7XG4gIH1cblxuICBmdW5jdGlvbiBDb250ZXh0KHRyeUxvY3NMaXN0KSB7XG4gICAgLy8gVGhlIHJvb3QgZW50cnkgb2JqZWN0IChlZmZlY3RpdmVseSBhIHRyeSBzdGF0ZW1lbnQgd2l0aG91dCBhIGNhdGNoXG4gICAgLy8gb3IgYSBmaW5hbGx5IGJsb2NrKSBnaXZlcyB1cyBhIHBsYWNlIHRvIHN0b3JlIHZhbHVlcyB0aHJvd24gZnJvbVxuICAgIC8vIGxvY2F0aW9ucyB3aGVyZSB0aGVyZSBpcyBubyBlbmNsb3NpbmcgdHJ5IHN0YXRlbWVudC5cbiAgICB0aGlzLnRyeUVudHJpZXMgPSBbeyB0cnlMb2M6IFwicm9vdFwiIH1dO1xuICAgIHRyeUxvY3NMaXN0LmZvckVhY2gocHVzaFRyeUVudHJ5LCB0aGlzKTtcbiAgICB0aGlzLnJlc2V0KHRydWUpO1xuICB9XG5cbiAgZXhwb3J0cy5rZXlzID0gZnVuY3Rpb24ob2JqZWN0KSB7XG4gICAgdmFyIGtleXMgPSBbXTtcbiAgICBmb3IgKHZhciBrZXkgaW4gb2JqZWN0KSB7XG4gICAgICBrZXlzLnB1c2goa2V5KTtcbiAgICB9XG4gICAga2V5cy5yZXZlcnNlKCk7XG5cbiAgICAvLyBSYXRoZXIgdGhhbiByZXR1cm5pbmcgYW4gb2JqZWN0IHdpdGggYSBuZXh0IG1ldGhvZCwgd2Uga2VlcFxuICAgIC8vIHRoaW5ncyBzaW1wbGUgYW5kIHJldHVybiB0aGUgbmV4dCBmdW5jdGlvbiBpdHNlbGYuXG4gICAgcmV0dXJuIGZ1bmN0aW9uIG5leHQoKSB7XG4gICAgICB3aGlsZSAoa2V5cy5sZW5ndGgpIHtcbiAgICAgICAgdmFyIGtleSA9IGtleXMucG9wKCk7XG4gICAgICAgIGlmIChrZXkgaW4gb2JqZWN0KSB7XG4gICAgICAgICAgbmV4dC52YWx1ZSA9IGtleTtcbiAgICAgICAgICBuZXh0LmRvbmUgPSBmYWxzZTtcbiAgICAgICAgICByZXR1cm4gbmV4dDtcbiAgICAgICAgfVxuICAgICAgfVxuXG4gICAgICAvLyBUbyBhdm9pZCBjcmVhdGluZyBhbiBhZGRpdGlvbmFsIG9iamVjdCwgd2UganVzdCBoYW5nIHRoZSAudmFsdWVcbiAgICAgIC8vIGFuZCAuZG9uZSBwcm9wZXJ0aWVzIG9mZiB0aGUgbmV4dCBmdW5jdGlvbiBvYmplY3QgaXRzZWxmLiBUaGlzXG4gICAgICAvLyBhbHNvIGVuc3VyZXMgdGhhdCB0aGUgbWluaWZpZXIgd2lsbCBub3QgYW5vbnltaXplIHRoZSBmdW5jdGlvbi5cbiAgICAgIG5leHQuZG9uZSA9IHRydWU7XG4gICAgICByZXR1cm4gbmV4dDtcbiAgICB9O1xuICB9O1xuXG4gIGZ1bmN0aW9uIHZhbHVlcyhpdGVyYWJsZSkge1xuICAgIGlmIChpdGVyYWJsZSkge1xuICAgICAgdmFyIGl0ZXJhdG9yTWV0aG9kID0gaXRlcmFibGVbaXRlcmF0b3JTeW1ib2xdO1xuICAgICAgaWYgKGl0ZXJhdG9yTWV0aG9kKSB7XG4gICAgICAgIHJldHVybiBpdGVyYXRvck1ldGhvZC5jYWxsKGl0ZXJhYmxlKTtcbiAgICAgIH1cblxuICAgICAgaWYgKHR5cGVvZiBpdGVyYWJsZS5uZXh0ID09PSBcImZ1bmN0aW9uXCIpIHtcbiAgICAgICAgcmV0dXJuIGl0ZXJhYmxlO1xuICAgICAgfVxuXG4gICAgICBpZiAoIWlzTmFOKGl0ZXJhYmxlLmxlbmd0aCkpIHtcbiAgICAgICAgdmFyIGkgPSAtMSwgbmV4dCA9IGZ1bmN0aW9uIG5leHQoKSB7XG4gICAgICAgICAgd2hpbGUgKCsraSA8IGl0ZXJhYmxlLmxlbmd0aCkge1xuICAgICAgICAgICAgaWYgKGhhc093bi5jYWxsKGl0ZXJhYmxlLCBpKSkge1xuICAgICAgICAgICAgICBuZXh0LnZhbHVlID0gaXRlcmFibGVbaV07XG4gICAgICAgICAgICAgIG5leHQuZG9uZSA9IGZhbHNlO1xuICAgICAgICAgICAgICByZXR1cm4gbmV4dDtcbiAgICAgICAgICAgIH1cbiAgICAgICAgICB9XG5cbiAgICAgICAgICBuZXh0LnZhbHVlID0gdW5kZWZpbmVkO1xuICAgICAgICAgIG5leHQuZG9uZSA9IHRydWU7XG5cbiAgICAgICAgICByZXR1cm4gbmV4dDtcbiAgICAgICAgfTtcblxuICAgICAgICByZXR1cm4gbmV4dC5uZXh0ID0gbmV4dDtcbiAgICAgIH1cbiAgICB9XG5cbiAgICAvLyBSZXR1cm4gYW4gaXRlcmF0b3Igd2l0aCBubyB2YWx1ZXMuXG4gICAgcmV0dXJuIHsgbmV4dDogZG9uZVJlc3VsdCB9O1xuICB9XG4gIGV4cG9ydHMudmFsdWVzID0gdmFsdWVzO1xuXG4gIGZ1bmN0aW9uIGRvbmVSZXN1bHQoKSB7XG4gICAgcmV0dXJuIHsgdmFsdWU6IHVuZGVmaW5lZCwgZG9uZTogdHJ1ZSB9O1xuICB9XG5cbiAgQ29udGV4dC5wcm90b3R5cGUgPSB7XG4gICAgY29uc3RydWN0b3I6IENvbnRleHQsXG5cbiAgICByZXNldDogZnVuY3Rpb24oc2tpcFRlbXBSZXNldCkge1xuICAgICAgdGhpcy5wcmV2ID0gMDtcbiAgICAgIHRoaXMubmV4dCA9IDA7XG4gICAgICAvLyBSZXNldHRpbmcgY29udGV4dC5fc2VudCBmb3IgbGVnYWN5IHN1cHBvcnQgb2YgQmFiZWwnc1xuICAgICAgLy8gZnVuY3Rpb24uc2VudCBpbXBsZW1lbnRhdGlvbi5cbiAgICAgIHRoaXMuc2VudCA9IHRoaXMuX3NlbnQgPSB1bmRlZmluZWQ7XG4gICAgICB0aGlzLmRvbmUgPSBmYWxzZTtcbiAgICAgIHRoaXMuZGVsZWdhdGUgPSBudWxsO1xuXG4gICAgICB0aGlzLm1ldGhvZCA9IFwibmV4dFwiO1xuICAgICAgdGhpcy5hcmcgPSB1bmRlZmluZWQ7XG5cbiAgICAgIHRoaXMudHJ5RW50cmllcy5mb3JFYWNoKHJlc2V0VHJ5RW50cnkpO1xuXG4gICAgICBpZiAoIXNraXBUZW1wUmVzZXQpIHtcbiAgICAgICAgZm9yICh2YXIgbmFtZSBpbiB0aGlzKSB7XG4gICAgICAgICAgLy8gTm90IHN1cmUgYWJvdXQgdGhlIG9wdGltYWwgb3JkZXIgb2YgdGhlc2UgY29uZGl0aW9uczpcbiAgICAgICAgICBpZiAobmFtZS5jaGFyQXQoMCkgPT09IFwidFwiICYmXG4gICAgICAgICAgICAgIGhhc093bi5jYWxsKHRoaXMsIG5hbWUpICYmXG4gICAgICAgICAgICAgICFpc05hTigrbmFtZS5zbGljZSgxKSkpIHtcbiAgICAgICAgICAgIHRoaXNbbmFtZV0gPSB1bmRlZmluZWQ7XG4gICAgICAgICAgfVxuICAgICAgICB9XG4gICAgICB9XG4gICAgfSxcblxuICAgIHN0b3A6IGZ1bmN0aW9uKCkge1xuICAgICAgdGhpcy5kb25lID0gdHJ1ZTtcblxuICAgICAgdmFyIHJvb3RFbnRyeSA9IHRoaXMudHJ5RW50cmllc1swXTtcbiAgICAgIHZhciByb290UmVjb3JkID0gcm9vdEVudHJ5LmNvbXBsZXRpb247XG4gICAgICBpZiAocm9vdFJlY29yZC50eXBlID09PSBcInRocm93XCIpIHtcbiAgICAgICAgdGhyb3cgcm9vdFJlY29yZC5hcmc7XG4gICAgICB9XG5cbiAgICAgIHJldHVybiB0aGlzLnJ2YWw7XG4gICAgfSxcblxuICAgIGRpc3BhdGNoRXhjZXB0aW9uOiBmdW5jdGlvbihleGNlcHRpb24pIHtcbiAgICAgIGlmICh0aGlzLmRvbmUpIHtcbiAgICAgICAgdGhyb3cgZXhjZXB0aW9uO1xuICAgICAgfVxuXG4gICAgICB2YXIgY29udGV4dCA9IHRoaXM7XG4gICAgICBmdW5jdGlvbiBoYW5kbGUobG9jLCBjYXVnaHQpIHtcbiAgICAgICAgcmVjb3JkLnR5cGUgPSBcInRocm93XCI7XG4gICAgICAgIHJlY29yZC5hcmcgPSBleGNlcHRpb247XG4gICAgICAgIGNvbnRleHQubmV4dCA9IGxvYztcblxuICAgICAgICBpZiAoY2F1Z2h0KSB7XG4gICAgICAgICAgLy8gSWYgdGhlIGRpc3BhdGNoZWQgZXhjZXB0aW9uIHdhcyBjYXVnaHQgYnkgYSBjYXRjaCBibG9jayxcbiAgICAgICAgICAvLyB0aGVuIGxldCB0aGF0IGNhdGNoIGJsb2NrIGhhbmRsZSB0aGUgZXhjZXB0aW9uIG5vcm1hbGx5LlxuICAgICAgICAgIGNvbnRleHQubWV0aG9kID0gXCJuZXh0XCI7XG4gICAgICAgICAgY29udGV4dC5hcmcgPSB1bmRlZmluZWQ7XG4gICAgICAgIH1cblxuICAgICAgICByZXR1cm4gISEgY2F1Z2h0O1xuICAgICAgfVxuXG4gICAgICBmb3IgKHZhciBpID0gdGhpcy50cnlFbnRyaWVzLmxlbmd0aCAtIDE7IGkgPj0gMDsgLS1pKSB7XG4gICAgICAgIHZhciBlbnRyeSA9IHRoaXMudHJ5RW50cmllc1tpXTtcbiAgICAgICAgdmFyIHJlY29yZCA9IGVudHJ5LmNvbXBsZXRpb247XG5cbiAgICAgICAgaWYgKGVudHJ5LnRyeUxvYyA9PT0gXCJyb290XCIpIHtcbiAgICAgICAgICAvLyBFeGNlcHRpb24gdGhyb3duIG91dHNpZGUgb2YgYW55IHRyeSBibG9jayB0aGF0IGNvdWxkIGhhbmRsZVxuICAgICAgICAgIC8vIGl0LCBzbyBzZXQgdGhlIGNvbXBsZXRpb24gdmFsdWUgb2YgdGhlIGVudGlyZSBmdW5jdGlvbiB0b1xuICAgICAgICAgIC8vIHRocm93IHRoZSBleGNlcHRpb24uXG4gICAgICAgICAgcmV0dXJuIGhhbmRsZShcImVuZFwiKTtcbiAgICAgICAgfVxuXG4gICAgICAgIGlmIChlbnRyeS50cnlMb2MgPD0gdGhpcy5wcmV2KSB7XG4gICAgICAgICAgdmFyIGhhc0NhdGNoID0gaGFzT3duLmNhbGwoZW50cnksIFwiY2F0Y2hMb2NcIik7XG4gICAgICAgICAgdmFyIGhhc0ZpbmFsbHkgPSBoYXNPd24uY2FsbChlbnRyeSwgXCJmaW5hbGx5TG9jXCIpO1xuXG4gICAgICAgICAgaWYgKGhhc0NhdGNoICYmIGhhc0ZpbmFsbHkpIHtcbiAgICAgICAgICAgIGlmICh0aGlzLnByZXYgPCBlbnRyeS5jYXRjaExvYykge1xuICAgICAgICAgICAgICByZXR1cm4gaGFuZGxlKGVudHJ5LmNhdGNoTG9jLCB0cnVlKTtcbiAgICAgICAgICAgIH0gZWxzZSBpZiAodGhpcy5wcmV2IDwgZW50cnkuZmluYWxseUxvYykge1xuICAgICAgICAgICAgICByZXR1cm4gaGFuZGxlKGVudHJ5LmZpbmFsbHlMb2MpO1xuICAgICAgICAgICAgfVxuXG4gICAgICAgICAgfSBlbHNlIGlmIChoYXNDYXRjaCkge1xuICAgICAgICAgICAgaWYgKHRoaXMucHJldiA8IGVudHJ5LmNhdGNoTG9jKSB7XG4gICAgICAgICAgICAgIHJldHVybiBoYW5kbGUoZW50cnkuY2F0Y2hMb2MsIHRydWUpO1xuICAgICAgICAgICAgfVxuXG4gICAgICAgICAgfSBlbHNlIGlmIChoYXNGaW5hbGx5KSB7XG4gICAgICAgICAgICBpZiAodGhpcy5wcmV2IDwgZW50cnkuZmluYWxseUxvYykge1xuICAgICAgICAgICAgICByZXR1cm4gaGFuZGxlKGVudHJ5LmZpbmFsbHlMb2MpO1xuICAgICAgICAgICAgfVxuXG4gICAgICAgICAgfSBlbHNlIHtcbiAgICAgICAgICAgIHRocm93IG5ldyBFcnJvcihcInRyeSBzdGF0ZW1lbnQgd2l0aG91dCBjYXRjaCBvciBmaW5hbGx5XCIpO1xuICAgICAgICAgIH1cbiAgICAgICAgfVxuICAgICAgfVxuICAgIH0sXG5cbiAgICBhYnJ1cHQ6IGZ1bmN0aW9uKHR5cGUsIGFyZykge1xuICAgICAgZm9yICh2YXIgaSA9IHRoaXMudHJ5RW50cmllcy5sZW5ndGggLSAxOyBpID49IDA7IC0taSkge1xuICAgICAgICB2YXIgZW50cnkgPSB0aGlzLnRyeUVudHJpZXNbaV07XG4gICAgICAgIGlmIChlbnRyeS50cnlMb2MgPD0gdGhpcy5wcmV2ICYmXG4gICAgICAgICAgICBoYXNPd24uY2FsbChlbnRyeSwgXCJmaW5hbGx5TG9jXCIpICYmXG4gICAgICAgICAgICB0aGlzLnByZXYgPCBlbnRyeS5maW5hbGx5TG9jKSB7XG4gICAgICAgICAgdmFyIGZpbmFsbHlFbnRyeSA9IGVudHJ5O1xuICAgICAgICAgIGJyZWFrO1xuICAgICAgICB9XG4gICAgICB9XG5cbiAgICAgIGlmIChmaW5hbGx5RW50cnkgJiZcbiAgICAgICAgICAodHlwZSA9PT0gXCJicmVha1wiIHx8XG4gICAgICAgICAgIHR5cGUgPT09IFwiY29udGludWVcIikgJiZcbiAgICAgICAgICBmaW5hbGx5RW50cnkudHJ5TG9jIDw9IGFyZyAmJlxuICAgICAgICAgIGFyZyA8PSBmaW5hbGx5RW50cnkuZmluYWxseUxvYykge1xuICAgICAgICAvLyBJZ25vcmUgdGhlIGZpbmFsbHkgZW50cnkgaWYgY29udHJvbCBpcyBub3QganVtcGluZyB0byBhXG4gICAgICAgIC8vIGxvY2F0aW9uIG91dHNpZGUgdGhlIHRyeS9jYXRjaCBibG9jay5cbiAgICAgICAgZmluYWxseUVudHJ5ID0gbnVsbDtcbiAgICAgIH1cblxuICAgICAgdmFyIHJlY29yZCA9IGZpbmFsbHlFbnRyeSA/IGZpbmFsbHlFbnRyeS5jb21wbGV0aW9uIDoge307XG4gICAgICByZWNvcmQudHlwZSA9IHR5cGU7XG4gICAgICByZWNvcmQuYXJnID0gYXJnO1xuXG4gICAgICBpZiAoZmluYWxseUVudHJ5KSB7XG4gICAgICAgIHRoaXMubWV0aG9kID0gXCJuZXh0XCI7XG4gICAgICAgIHRoaXMubmV4dCA9IGZpbmFsbHlFbnRyeS5maW5hbGx5TG9jO1xuICAgICAgICByZXR1cm4gQ29udGludWVTZW50aW5lbDtcbiAgICAgIH1cblxuICAgICAgcmV0dXJuIHRoaXMuY29tcGxldGUocmVjb3JkKTtcbiAgICB9LFxuXG4gICAgY29tcGxldGU6IGZ1bmN0aW9uKHJlY29yZCwgYWZ0ZXJMb2MpIHtcbiAgICAgIGlmIChyZWNvcmQudHlwZSA9PT0gXCJ0aHJvd1wiKSB7XG4gICAgICAgIHRocm93IHJlY29yZC5hcmc7XG4gICAgICB9XG5cbiAgICAgIGlmIChyZWNvcmQudHlwZSA9PT0gXCJicmVha1wiIHx8XG4gICAgICAgICAgcmVjb3JkLnR5cGUgPT09IFwiY29udGludWVcIikge1xuICAgICAgICB0aGlzLm5leHQgPSByZWNvcmQuYXJnO1xuICAgICAgfSBlbHNlIGlmIChyZWNvcmQudHlwZSA9PT0gXCJyZXR1cm5cIikge1xuICAgICAgICB0aGlzLnJ2YWwgPSB0aGlzLmFyZyA9IHJlY29yZC5hcmc7XG4gICAgICAgIHRoaXMubWV0aG9kID0gXCJyZXR1cm5cIjtcbiAgICAgICAgdGhpcy5uZXh0ID0gXCJlbmRcIjtcbiAgICAgIH0gZWxzZSBpZiAocmVjb3JkLnR5cGUgPT09IFwibm9ybWFsXCIgJiYgYWZ0ZXJMb2MpIHtcbiAgICAgICAgdGhpcy5uZXh0ID0gYWZ0ZXJMb2M7XG4gICAgICB9XG5cbiAgICAgIHJldHVybiBDb250aW51ZVNlbnRpbmVsO1xuICAgIH0sXG5cbiAgICBmaW5pc2g6IGZ1bmN0aW9uKGZpbmFsbHlMb2MpIHtcbiAgICAgIGZvciAodmFyIGkgPSB0aGlzLnRyeUVudHJpZXMubGVuZ3RoIC0gMTsgaSA+PSAwOyAtLWkpIHtcbiAgICAgICAgdmFyIGVudHJ5ID0gdGhpcy50cnlFbnRyaWVzW2ldO1xuICAgICAgICBpZiAoZW50cnkuZmluYWxseUxvYyA9PT0gZmluYWxseUxvYykge1xuICAgICAgICAgIHRoaXMuY29tcGxldGUoZW50cnkuY29tcGxldGlvbiwgZW50cnkuYWZ0ZXJMb2MpO1xuICAgICAgICAgIHJlc2V0VHJ5RW50cnkoZW50cnkpO1xuICAgICAgICAgIHJldHVybiBDb250aW51ZVNlbnRpbmVsO1xuICAgICAgICB9XG4gICAgICB9XG4gICAgfSxcblxuICAgIFwiY2F0Y2hcIjogZnVuY3Rpb24odHJ5TG9jKSB7XG4gICAgICBmb3IgKHZhciBpID0gdGhpcy50cnlFbnRyaWVzLmxlbmd0aCAtIDE7IGkgPj0gMDsgLS1pKSB7XG4gICAgICAgIHZhciBlbnRyeSA9IHRoaXMudHJ5RW50cmllc1tpXTtcbiAgICAgICAgaWYgKGVudHJ5LnRyeUxvYyA9PT0gdHJ5TG9jKSB7XG4gICAgICAgICAgdmFyIHJlY29yZCA9IGVudHJ5LmNvbXBsZXRpb247XG4gICAgICAgICAgaWYgKHJlY29yZC50eXBlID09PSBcInRocm93XCIpIHtcbiAgICAgICAgICAgIHZhciB0aHJvd24gPSByZWNvcmQuYXJnO1xuICAgICAgICAgICAgcmVzZXRUcnlFbnRyeShlbnRyeSk7XG4gICAgICAgICAgfVxuICAgICAgICAgIHJldHVybiB0aHJvd247XG4gICAgICAgIH1cbiAgICAgIH1cblxuICAgICAgLy8gVGhlIGNvbnRleHQuY2F0Y2ggbWV0aG9kIG11c3Qgb25seSBiZSBjYWxsZWQgd2l0aCBhIGxvY2F0aW9uXG4gICAgICAvLyBhcmd1bWVudCB0aGF0IGNvcnJlc3BvbmRzIHRvIGEga25vd24gY2F0Y2ggYmxvY2suXG4gICAgICB0aHJvdyBuZXcgRXJyb3IoXCJpbGxlZ2FsIGNhdGNoIGF0dGVtcHRcIik7XG4gICAgfSxcblxuICAgIGRlbGVnYXRlWWllbGQ6IGZ1bmN0aW9uKGl0ZXJhYmxlLCByZXN1bHROYW1lLCBuZXh0TG9jKSB7XG4gICAgICB0aGlzLmRlbGVnYXRlID0ge1xuICAgICAgICBpdGVyYXRvcjogdmFsdWVzKGl0ZXJhYmxlKSxcbiAgICAgICAgcmVzdWx0TmFtZTogcmVzdWx0TmFtZSxcbiAgICAgICAgbmV4dExvYzogbmV4dExvY1xuICAgICAgfTtcblxuICAgICAgaWYgKHRoaXMubWV0aG9kID09PSBcIm5leHRcIikge1xuICAgICAgICAvLyBEZWxpYmVyYXRlbHkgZm9yZ2V0IHRoZSBsYXN0IHNlbnQgdmFsdWUgc28gdGhhdCB3ZSBkb24ndFxuICAgICAgICAvLyBhY2NpZGVudGFsbHkgcGFzcyBpdCBvbiB0byB0aGUgZGVsZWdhdGUuXG4gICAgICAgIHRoaXMuYXJnID0gdW5kZWZpbmVkO1xuICAgICAgfVxuXG4gICAgICByZXR1cm4gQ29udGludWVTZW50aW5lbDtcbiAgICB9XG4gIH07XG5cbiAgLy8gUmVnYXJkbGVzcyBvZiB3aGV0aGVyIHRoaXMgc2NyaXB0IGlzIGV4ZWN1dGluZyBhcyBhIENvbW1vbkpTIG1vZHVsZVxuICAvLyBvciBub3QsIHJldHVybiB0aGUgcnVudGltZSBvYmplY3Qgc28gdGhhdCB3ZSBjYW4gZGVjbGFyZSB0aGUgdmFyaWFibGVcbiAgLy8gcmVnZW5lcmF0b3JSdW50aW1lIGluIHRoZSBvdXRlciBzY29wZSwgd2hpY2ggYWxsb3dzIHRoaXMgbW9kdWxlIHRvIGJlXG4gIC8vIGluamVjdGVkIGVhc2lseSBieSBgYmluL3JlZ2VuZXJhdG9yIC0taW5jbHVkZS1ydW50aW1lIHNjcmlwdC5qc2AuXG4gIHJldHVybiBleHBvcnRzO1xuXG59KFxuICAvLyBJZiB0aGlzIHNjcmlwdCBpcyBleGVjdXRpbmcgYXMgYSBDb21tb25KUyBtb2R1bGUsIHVzZSBtb2R1bGUuZXhwb3J0c1xuICAvLyBhcyB0aGUgcmVnZW5lcmF0b3JSdW50aW1lIG5hbWVzcGFjZS4gT3RoZXJ3aXNlIGNyZWF0ZSBhIG5ldyBlbXB0eVxuICAvLyBvYmplY3QuIEVpdGhlciB3YXksIHRoZSByZXN1bHRpbmcgb2JqZWN0IHdpbGwgYmUgdXNlZCB0byBpbml0aWFsaXplXG4gIC8vIHRoZSByZWdlbmVyYXRvclJ1bnRpbWUgdmFyaWFibGUgYXQgdGhlIHRvcCBvZiB0aGlzIGZpbGUuXG4gIHR5cGVvZiBtb2R1bGUgPT09IFwib2JqZWN0XCIgPyBtb2R1bGUuZXhwb3J0cyA6IHt9XG4pKTtcblxudHJ5IHtcbiAgcmVnZW5lcmF0b3JSdW50aW1lID0gcnVudGltZTtcbn0gY2F0Y2ggKGFjY2lkZW50YWxTdHJpY3RNb2RlKSB7XG4gIC8vIFRoaXMgbW9kdWxlIHNob3VsZCBub3QgYmUgcnVubmluZyBpbiBzdHJpY3QgbW9kZSwgc28gdGhlIGFib3ZlXG4gIC8vIGFzc2lnbm1lbnQgc2hvdWxkIGFsd2F5cyB3b3JrIHVubGVzcyBzb21ldGhpbmcgaXMgbWlzY29uZmlndXJlZC4gSnVzdFxuICAvLyBpbiBjYXNlIHJ1bnRpbWUuanMgYWNjaWRlbnRhbGx5IHJ1bnMgaW4gc3RyaWN0IG1vZGUsIHdlIGNhbiBlc2NhcGVcbiAgLy8gc3RyaWN0IG1vZGUgdXNpbmcgYSBnbG9iYWwgRnVuY3Rpb24gY2FsbC4gVGhpcyBjb3VsZCBjb25jZWl2YWJseSBmYWlsXG4gIC8vIGlmIGEgQ29udGVudCBTZWN1cml0eSBQb2xpY3kgZm9yYmlkcyB1c2luZyBGdW5jdGlvbiwgYnV0IGluIHRoYXQgY2FzZVxuICAvLyB0aGUgcHJvcGVyIHNvbHV0aW9uIGlzIHRvIGZpeCB0aGUgYWNjaWRlbnRhbCBzdHJpY3QgbW9kZSBwcm9ibGVtLiBJZlxuICAvLyB5b3UndmUgbWlzY29uZmlndXJlZCB5b3VyIGJ1bmRsZXIgdG8gZm9yY2Ugc3RyaWN0IG1vZGUgYW5kIGFwcGxpZWQgYVxuICAvLyBDU1AgdG8gZm9yYmlkIEZ1bmN0aW9uLCBhbmQgeW91J3JlIG5vdCB3aWxsaW5nIHRvIGZpeCBlaXRoZXIgb2YgdGhvc2VcbiAgLy8gcHJvYmxlbXMsIHBsZWFzZSBkZXRhaWwgeW91ciB1bmlxdWUgcHJlZGljYW1lbnQgaW4gYSBHaXRIdWIgaXNzdWUuXG4gIEZ1bmN0aW9uKFwiclwiLCBcInJlZ2VuZXJhdG9yUnVudGltZSA9IHJcIikocnVudGltZSk7XG59XG4iLCJjb25zdCByZWdlbmVyYXRvclJ1bnRpbWUgPSByZXF1aXJlKFwicmVnZW5lcmF0b3ItcnVudGltZVwiKTtcclxuXHJcbmNvbnN0IHRvcGxpbmUgPSBkb2N1bWVudC5xdWVyeVNlbGVjdG9yKFwiLm1lbnVcIik7XHJcbmNvbnN0IG1vYmlsZU1lbnUgPSBkb2N1bWVudC5nZXRFbGVtZW50QnlJZChcIm1vYmlsZU1lbnVcIik7XHJcbmNvbnN0IGNsb3NlQnRuID0gZG9jdW1lbnQuZ2V0RWxlbWVudEJ5SWQoXCJjbG9zZUJ0blwiKTtcclxuY29uc3QgYnVyZ2VyID0gZG9jdW1lbnQuZ2V0RWxlbWVudEJ5SWQoXCJidXJnZXJcIik7XHJcbmNvbnN0IG1vYmlsZUxpc3QgPSBkb2N1bWVudC5nZXRFbGVtZW50QnlJZChcIm1vYmlsZUxpc3RcIik7XHJcbmNvbnN0IHNlZU1vcmUgPSBkb2N1bWVudC5nZXRFbGVtZW50QnlJZChcInNlZU1vcmVcIik7XHJcbmNvbnN0IGFjY29yZGVvbiA9IGRvY3VtZW50LmdldEVsZW1lbnRCeUlkKFwiYWNjb3JkZW9uXCIpO1xyXG5jb25zdCByZWFkTW9yZTEgPSBkb2N1bWVudC5nZXRFbGVtZW50QnlJZChcInJlYWRNb3JlMVwiKTtcclxuY29uc3QgcmVhZE1vcmUyID0gZG9jdW1lbnQuZ2V0RWxlbWVudEJ5SWQoXCJyZWFkTW9yZTJcIik7XHJcbmNvbnN0IHJlYWRMZXNzMSA9IGRvY3VtZW50LmdldEVsZW1lbnRCeUlkKFwicmVhZExlc3MxXCIpO1xyXG5jb25zdCByZWFkTGVzczIgPSBkb2N1bWVudC5nZXRFbGVtZW50QnlJZChcInJlYWRMZXNzMlwiKTtcclxuY29uc3QgbGlzdEZpcnN0ID0gZG9jdW1lbnQuZ2V0RWxlbWVudEJ5SWQoXCJsaXN0Rmlyc3RcIik7XHJcbmNvbnN0IHRleHRGaXJzdCA9IGRvY3VtZW50LmdldEVsZW1lbnRCeUlkKFwidGV4dEZpcnN0XCIpO1xyXG5jb25zdCB0ZXh0U2Vjb25kID0gZG9jdW1lbnQuZ2V0RWxlbWVudEJ5SWQoXCJ0ZXh0U2Vjb25kXCIpO1xyXG5jb25zdCBjYXJkcyA9IGRvY3VtZW50LmdldEVsZW1lbnRCeUlkKFwiY2FyZHNcIik7XHJcbmNvbnN0IGNhcmRBY3RpdmUgPSBkb2N1bWVudC5nZXRFbGVtZW50QnlJZChcImNhcmRBY3RpdmVcIik7XHJcbmxldCBjb3VudGVyID0gMztcclxubGV0IHJhaXNlciA9IDM7XHJcbmNvbnN0IHByb2R1Y3RzID0gW1xyXG4gIHtcclxuICAgIHNyYzogXCJpbWcvMS4gSW5kb29yLmpwZ1wiLFxyXG4gICAgc3VidGl0bGU6IFwiSW5kb29yIGVuZXJneSBzZXJ2aWNlc1wiLFxyXG4gICAgdGV4dDpcclxuICAgICAgXCJXZSBoZWxwZWQgSW5kb29yIGVuZXJneSBzZXJ2aWNlcyB0byBncmVhdHkgc2ltcGxpZnkgdGhlaXIgY2FzZSBtYW5hZ2VtZW50IHN5c3RlbS4uLlwiXHJcbiAgfSxcclxuICB7XHJcbiAgICBzcmM6IFwiaW1nLzIuIEJpcmRpZS5qcGdcIixcclxuICAgIHN1YnRpdGxlOiBcIkJpcmRpZSBHb2xkIFRvdXJzXCIsXHJcbiAgICB0ZXh0OlxyXG4gICAgICBcIldlIGhlbHBlZCBCaXJkeSBHb2xmIFRvdXJzIHRvIHN0YXkgcmVsZXZlYW50IG9uIGFuIGluY2xyZWFzaW5nbHkgY29tcGV0aXRpdmUgbWFya2V0Li4uXCJcclxuICB9LFxyXG4gIHtcclxuICAgIHNyYzogXCJpbWcvMy4gTm93V2hlcmUuanBnXCIsXHJcbiAgICBzdWJ0aXRsZTogXCJOb3dXaGVyZVwiLFxyXG4gICAgdGV4dDpcclxuICAgICAgXCJXZSBidWlsdCBhIHJlY29tbWVuZGF0aW9ucyBhcHAgZm9yIHBlb3BsZSB3b3JraW5nIGluIGNyZWF0aXZlIGluZHVzdHJpZXMuLi5cIlxyXG4gIH0sXHJcbiAge1xyXG4gICAgc3JjOiBcImltZy80LiBGeW5kaXFzdmFqcGVuLmpwZ1wiLFxyXG4gICAgc3VidGl0bGU6IFwiRnluZGlxc3ZhanBlblwiLFxyXG4gICAgdGV4dDpcclxuICAgICAgXCJXZSBjcmVhdGVkIGFuIGFwcCB0aGF0IGhlbHBlZCBjdXN0b21lcnMgZmluZCBnaWZ0cyBhbW9uZyBtb3JlIHRoYW4gMjkwMDAwMCBpdGVtcy4uLlwiXHJcbiAgfSxcclxuICB7XHJcbiAgICBzcmM6IFwiaW1nLzUuIEJ5dGhqdWwuanBnXCIsXHJcbiAgICBzdWJ0aXRsZTogXCJCeXRoanVsXCIsXHJcbiAgICB0ZXh0OlxyXG4gICAgICBcIldlIGNyZWF0ZWQgdGlyZSBmYXNoaW9uIGZvciB0aGUgaW5jcmVhc2luZ2x5IGVnYWxpdGFyaWFuIGNhciBtYWludGluYWNlIG1hcmtldC4uLlwiXHJcbiAgfSxcclxuICB7XHJcbiAgICBzcmM6IFwiaW1nLzYuIFRpY2tpbi5qcGdcIixcclxuICAgIHN1YnRpdGxlOiBcIlRpY2tpblwiLFxyXG4gICAgdGV4dDpcclxuICAgICAgXCJXZSBpbnZlbnRlZCBhIHRpbWUgcmVwb3J0aW5nIHN5c3RlbSBmb3IgcGVvcGxlIHdobyBoYXRlIHRpbWUgdHJhY2tpbmcuLi5cIlxyXG4gIH0sXHJcbiAge1xyXG4gICAgc3JjOiBcImltZy83LiBVYmVybWVkcy5qcGdcIixcclxuICAgIHN1YnRpdGxlOiBcIlViZXJtZWRzXCIsXHJcbiAgICB0ZXh0OlxyXG4gICAgICBcIldlIGNyZWF0ZWQgYW4gYXBwIHRoYXQgaGVscGVkIGN1c3RvbWVycyBmaW5kIGdpZnRzIGFtb25nIG1vcmUgdGhhbiAyOTAwMDAwIGl0ZW1zLi4uXCJcclxuICB9LFxyXG4gIHtcclxuICAgIHNyYzogXCJpbWcvOC4gVsOkc3R0cmFmaWsgQ2FsY3VsYXRvci5qcGdcIixcclxuICAgIHN1YnRpdGxlOiBcIlbDpHN0dHJhZmlrIENhbGN1bGF0b3JcIixcclxuICAgIHRleHQ6XHJcbiAgICAgIFwiV2UgY3JlYXRlZCB0aXJlIGZhc2hpb24gZm9yIHRoZSBpbmNyZWFzaW5nbHkgZWdhbGl0YXJpYW4gY2FyIG1haW50aW5hY2UgbWFya2V0Li4uXCJcclxuICB9LFxyXG4gIHtcclxuICAgIHNyYzogXCJpbWcvOS4gVHLDpG5pbmdzcGFydG5lci5qcGdcIixcclxuICAgIHN1YnRpdGxlOiBcIlRyw6RuaW5nc3BhcnRuZXJcIixcclxuICAgIHRleHQ6XHJcbiAgICAgIFwiV2UgaW52ZW50ZWQgYSB0aW1lIHJlcG9ydGluZyBzeXN0ZW0gZm9yIHBlb3BsZSB3aG8gaGF0ZSB0aW1lIHRyYWNraW5nLi4uXCJcclxuICB9XHJcbl07XHJcblxyXG5kb2N1bWVudC5hZGRFdmVudExpc3RlbmVyKFwic2Nyb2xsXCIsICgpID0+IHtcclxuICBpZiAod2luZG93LnBhZ2VZT2Zmc2V0IDwgdG9wbGluZS5jbGllbnRIZWlnaHQpIHtcclxuICAgIHRvcGxpbmUuY2xhc3NMaXN0LnJlbW92ZShcImZpeGVkXCIpO1xyXG4gIH0gZWxzZSB7XHJcbiAgICB0b3BsaW5lLmNsYXNzTGlzdC5hZGQoXCJmaXhlZFwiKTtcclxuICB9XHJcbn0pO1xyXG5cclxuYnVyZ2VyLm9uY2xpY2sgPSBlID0+IHtcclxuICBlLnByZXZlbnREZWZhdWx0KCk7XHJcbiAgbW9iaWxlTWVudS5jbGFzc0xpc3QudG9nZ2xlKFwiaGlkZVwiKTtcclxufTtcclxuXHJcbmNsb3NlQnRuLm9uY2xpY2sgPSBlID0+IHtcclxuICBlLnByZXZlbnREZWZhdWx0KCk7XHJcbiAgbW9iaWxlTWVudS5jbGFzc0xpc3QudG9nZ2xlKFwiaGlkZVwiKTtcclxufTtcclxuXHJcbm1vYmlsZUxpc3Qub25jbGljayA9ICgpID0+IHtcclxuICBtb2JpbGVNZW51LmNsYXNzTGlzdC50b2dnbGUoXCJoaWRlXCIpO1xyXG59O1xyXG5cclxuLy8gYWNjb3JkZW9uLmFkZEV2ZW50TGlzdGVuZXIoXCJjbGlja1wiLCBlID0+IHtcclxuLy8gICBsZXQgdGFyZ2V0ID0gZS50YXJnZXQ7XHJcbi8vICAgY29uc3QgbGlzdCA9IGRvY3VtZW50LmdldEVsZW1lbnRzQnlDbGFzc05hbWUoXCJob3ctd2UtZG9fX3RhYmxldC1pdGVtXCIpO1xyXG4vLyAgIGxldCBhcnIgPSBbLi4ubGlzdF07XHJcbi8vICAgaWYgKHRhcmdldC5jbGFzc0xpc3QuY29udGFpbnMoJ3Nob3cnKSkge1xyXG4vLyAgICAgdGFyZ2V0LmNsYXNzTGlzdC50b2dnbGUoXCJzaG93XCIpO1xyXG4vLyAgIH0gZWxzZSB7XHJcbi8vICAgICBhcnIubWFwKGkgPT4gaS5jbGFzc0xpc3QucmVtb3ZlKFwic2hvd1wiKSk7XHJcbi8vICAgICB0YXJnZXQuY2xhc3NMaXN0LnRvZ2dsZShcInNob3dcIik7XHJcbi8vICAgfVxyXG4vLyB9KTtcclxuXHJcbi8vIGNhcmRzLmFkZEV2ZW50TGlzdGVuZXIoXCJtb3VzZW92ZXJcIiwgZSA9PiB7XHJcbi8vICAgY29uc3QgdGFyZ2V0ID0gZS50YXJnZXQ7XHJcbi8vICAgY29uc3QgY2hpbGRzID0gY2FyZHMuY2hpbGRyZW47XHJcbi8vICAgaWYodGFyZ2V0LmNsYXNzTGlzdC5jb250YWlucygnbWV0aG9kc19fY2FyZCcpKSB7XHJcbi8vICAgICBmb3IgKGxldCBpPTAsIGNoaWxkOyBjaGlsZCA9IGNoaWxkc1tpXTsgaSsrKSB7XHJcbi8vICAgICAgIGNoaWxkLmNsYXNzTGlzdC5yZW1vdmUoJ2FjdGl2ZScpXHJcbi8vICAgICB9XHJcbi8vICAgICB0YXJnZXQuY2xhc3NMaXN0LmFkZCgnYWN0aXZlJyk7XHJcbi8vICAgfSBlbHNlIHJldHVyblxyXG4vLyB9KTtcclxuXHJcbnJlYWRNb3JlMS5vbmNsaWNrID0gKCkgPT4ge1xyXG4gIGxpc3RGaXJzdC5jbGFzc0xpc3QudG9nZ2xlKFwibW9yZVwiKTtcclxuICB0ZXh0Rmlyc3QuY2xhc3NMaXN0LnRvZ2dsZShcIm1vcmVcIik7XHJcbiAgcmVhZE1vcmUxLmNsYXNzTGlzdC50b2dnbGUoXCJoaWRkZW5cIik7XHJcbiAgcmVhZExlc3MxLmNsYXNzTGlzdC50b2dnbGUoXCJoaWRkZW5cIik7XHJcbn07XHJcblxyXG5yZWFkTGVzczEub25jbGljayA9ICgpID0+IHtcclxuICBsaXN0Rmlyc3QuY2xhc3NMaXN0LnRvZ2dsZShcIm1vcmVcIik7XHJcbiAgdGV4dEZpcnN0LmNsYXNzTGlzdC50b2dnbGUoXCJtb3JlXCIpO1xyXG4gIHJlYWRNb3JlMS5jbGFzc0xpc3QudG9nZ2xlKFwiaGlkZGVuXCIpO1xyXG4gIHJlYWRMZXNzMS5jbGFzc0xpc3QudG9nZ2xlKFwiaGlkZGVuXCIpO1xyXG59O1xyXG5cclxuLy8gcmVhZE1vcmUyLm9uY2xpY2sgPSAoKSA9PiB7XHJcbi8vICAgdGV4dFNlY29uZC5jbGFzc0xpc3QudG9nZ2xlKFwibW9yZVwiKTtcclxuLy8gICByZWFkTW9yZTIuY2xhc3NMaXN0LnRvZ2dsZShcImhpZGRlblwiKTtcclxuLy8gICByZWFkTGVzczIuY2xhc3NMaXN0LnRvZ2dsZShcImhpZGRlblwiKTtcclxuLy8gfTtcclxuXHJcbi8vIHJlYWRMZXNzMi5vbmNsaWNrID0gKCkgPT4ge1xyXG4vLyAgIHRleHRTZWNvbmQuY2xhc3NMaXN0LnRvZ2dsZShcIm1vcmVcIik7XHJcbi8vICAgcmVhZE1vcmUyLmNsYXNzTGlzdC50b2dnbGUoXCJoaWRkZW5cIik7XHJcbi8vICAgcmVhZExlc3MyLmNsYXNzTGlzdC50b2dnbGUoXCJoaWRkZW5cIik7XHJcbi8vIH07XHJcblxyXG5jb25zdCByZW5kZXJQcm9kdWN0cyA9IGl0ZW0gPT4ge1xyXG4gIHJldHVybiBgPGRpdiBjbGFzcz1cImNvbC0xMiBjb2wtbWQtNiBjb2wtbGctNFwiPlxyXG4gIDxkaXYgY2xhc3M9XCJwcm9qZWN0c19fY2FyZFwiPlxyXG4gICAgPGRpdiBjbGFzcz1cInByb2plY3RzX19pbWctd3JhcHBlclwiPjxpbWcgc3JjPVwiJHtpdGVtLnNyY31cIiBhbHQ9XCJtYXNrXCI+PC9kaXY+XHJcbiAgICA8ZGl2IGNsYXNzPVwicHJvamVjdHNfX2luZm9cIj5cclxuICAgICAgPGg0IGNsYXNzPVwicHJvamVjdHNfX3N1YnRpdGxlXCI+JHtpdGVtLnN1YnRpdGxlfTwvaDQ+XHJcbiAgICAgIDxwIGNsYXNzPVwicHJvamVjdHNfX3RleHRcIj4ke2l0ZW0udGV4dH08L3A+XHJcbiAgICA8L2Rpdj5cclxuICA8L2Rpdj5cclxuPC9kaXY+YDtcclxufTtcclxuXHJcbmxldCByZW5kZXJTZWN0aW9uID0gcHJvamVjdHNEYXRhID0+IHtcclxuICBjb25zdCBwcm9qZWN0cyA9IHByb2plY3RzRGF0YS5tYXAoZWxlbWVudCA9PiByZW5kZXJQcm9kdWN0cyhlbGVtZW50KSk7XHJcbiAgZG9jdW1lbnQuZ2V0RWxlbWVudEJ5SWQoXCJwcm9qZWN0c1JlbmRlclwiKS5pbm5lckhUTUwgPSBwcm9qZWN0cy5qb2luKFwiXCIpO1xyXG59O1xyXG5cclxuc2VlTW9yZS5vbmNsaWNrID0gZSA9PiB7XHJcbiAgZS5wcmV2ZW50RGVmYXVsdCgpO1xyXG4gIGNvdW50ZXIgKz0gcmFpc2VyO1xyXG4gIHJlbmRlclNlY3Rpb24ocHJvZHVjdHMuc2xpY2UoMCwgY291bnRlcikpO1xyXG59O1xyXG5cclxud2luZG93LmFkZEV2ZW50TGlzdGVuZXIoXCJET01Db250ZW50TG9hZGVkXCIsICgpID0+IHtcclxuICBjb25zdCB3aXRkaENvdW50ZXIgPSBhc3luYyAoKSA9PiB7XHJcbiAgICBzd2l0Y2ggKHRydWUpIHtcclxuICAgICAgY2FzZSBkb2N1bWVudC5kb2N1bWVudEVsZW1lbnQuY2xpZW50V2lkdGggPiA3Njg6XHJcbiAgICAgICAgY291bnRlciA9IDk7XHJcbiAgICAgICAgYnJlYWs7XHJcbiAgICAgIGNhc2UgZG9jdW1lbnQuZG9jdW1lbnRFbGVtZW50LmNsaWVudFdpZHRoID4gNDE0OlxyXG4gICAgICAgIGNvdW50ZXIgPSA0O1xyXG4gICAgICAgIHJhaXNlciA9IDQ7XHJcbiAgICAgICAgYnJlYWs7XHJcbiAgICAgIGRlZmF1bHQ6XHJcbiAgICAgICAgY291bnRlciA9IDM7XHJcbiAgICAgICAgcmFpc2VyID0gMztcclxuICAgICAgICBicmVhaztcclxuICAgIH1cclxuICB9O1xyXG4gIHdpdGRoQ291bnRlcigpO1xyXG4gIHJlbmRlclNlY3Rpb24ocHJvZHVjdHMuc2xpY2UoMCwgY291bnRlcikpO1xyXG59KTtcclxuIl0sInByZUV4aXN0aW5nQ29tbWVudCI6Ii8vIyBzb3VyY2VNYXBwaW5nVVJMPWRhdGE6YXBwbGljYXRpb24vanNvbjtjaGFyc2V0PXV0Zi04O2Jhc2U2NCxleUoyWlhKemFXOXVJam96TENKemIzVnlZMlZ6SWpwYkltNXZaR1ZmYlc5a2RXeGxjeTlpY205M2MyVnlMWEJoWTJzdlgzQnlaV3gxWkdVdWFuTWlMQ0p1YjJSbFgyMXZaSFZzWlhNdmNtVm5aVzVsY21GMGIzSXRjblZ1ZEdsdFpTOXlkVzUwYVcxbExtcHpJaXdpY0hKdmFtVmpkSE12ZDJocGRHVndiM0owTFhOcGRHVXZjM0pqTDJwekwyRndjQzVxY3lKZExDSnVZVzFsY3lJNlcxMHNJbTFoY0hCcGJtZHpJam9pUVVGQlFUdEJRMEZCTzBGQlEwRTdRVUZEUVR0QlFVTkJPMEZCUTBFN1FVRkRRVHRCUVVOQk8wRkJRMEU3UVVGRFFUdEJRVU5CTzBGQlEwRTdRVUZEUVR0QlFVTkJPMEZCUTBFN1FVRkRRVHRCUVVOQk8wRkJRMEU3UVVGRFFUdEJRVU5CTzBGQlEwRTdRVUZEUVR0QlFVTkJPMEZCUTBFN1FVRkRRVHRCUVVOQk8wRkJRMEU3UVVGRFFUdEJRVU5CTzBGQlEwRTdRVUZEUVR0QlFVTkJPMEZCUTBFN1FVRkRRVHRCUVVOQk8wRkJRMEU3UVVGRFFUdEJRVU5CTzBGQlEwRTdRVUZEUVR0QlFVTkJPMEZCUTBFN1FVRkRRVHRCUVVOQk8wRkJRMEU3UVVGRFFUdEJRVU5CTzBGQlEwRTdRVUZEUVR0QlFVTkJPMEZCUTBFN1FVRkRRVHRCUVVOQk8wRkJRMEU3UVVGRFFUdEJRVU5CTzBGQlEwRTdRVUZEUVR0QlFVTkJPMEZCUTBFN1FVRkRRVHRCUVVOQk8wRkJRMEU3UVVGRFFUdEJRVU5CTzBGQlEwRTdRVUZEUVR0QlFVTkJPMEZCUTBFN1FVRkRRVHRCUVVOQk8wRkJRMEU3UVVGRFFUdEJRVU5CTzBGQlEwRTdRVUZEUVR0QlFVTkJPMEZCUTBFN1FVRkRRVHRCUVVOQk8wRkJRMEU3UVVGRFFUdEJRVU5CTzBGQlEwRTdRVUZEUVR0QlFVTkJPMEZCUTBFN1FVRkRRVHRCUVVOQk8wRkJRMEU3UVVGRFFUdEJRVU5CTzBGQlEwRTdRVUZEUVR0QlFVTkJPMEZCUTBFN1FVRkRRVHRCUVVOQk8wRkJRMEU3UVVGRFFUdEJRVU5CTzBGQlEwRTdRVUZEUVR0QlFVTkJPMEZCUTBFN1FVRkRRVHRCUVVOQk8wRkJRMEU3UVVGRFFUdEJRVU5CTzBGQlEwRTdRVUZEUVR0QlFVTkJPMEZCUTBFN1FVRkRRVHRCUVVOQk8wRkJRMEU3UVVGRFFUdEJRVU5CTzBGQlEwRTdRVUZEUVR0QlFVTkJPMEZCUTBFN1FVRkRRVHRCUVVOQk8wRkJRMEU3UVVGRFFUdEJRVU5CTzBGQlEwRTdRVUZEUVR0QlFVTkJPMEZCUTBFN1FVRkRRVHRCUVVOQk8wRkJRMEU3UVVGRFFUdEJRVU5CTzBGQlEwRTdRVUZEUVR0QlFVTkJPMEZCUTBFN1FVRkRRVHRCUVVOQk8wRkJRMEU3UVVGRFFUdEJRVU5CTzBGQlEwRTdRVUZEUVR0QlFVTkJPMEZCUTBFN1FVRkRRVHRCUVVOQk8wRkJRMEU3UVVGRFFUdEJRVU5CTzBGQlEwRTdRVUZEUVR0QlFVTkJPMEZCUTBFN1FVRkRRVHRCUVVOQk8wRkJRMEU3UVVGRFFUdEJRVU5CTzBGQlEwRTdRVUZEUVR0QlFVTkJPMEZCUTBFN1FVRkRRVHRCUVVOQk8wRkJRMEU3UVVGRFFUdEJRVU5CTzBGQlEwRTdRVUZEUVR0QlFVTkJPMEZCUTBFN1FVRkRRVHRCUVVOQk8wRkJRMEU3UVVGRFFUdEJRVU5CTzBGQlEwRTdRVUZEUVR0QlFVTkJPMEZCUTBFN1FVRkRRVHRCUVVOQk8wRkJRMEU3UVVGRFFUdEJRVU5CTzBGQlEwRTdRVUZEUVR0QlFVTkJPMEZCUTBFN1FVRkRRVHRCUVVOQk8wRkJRMEU3UVVGRFFUdEJRVU5CTzBGQlEwRTdRVUZEUVR0QlFVTkJPMEZCUTBFN1FVRkRRVHRCUVVOQk8wRkJRMEU3UVVGRFFUdEJRVU5CTzBGQlEwRTdRVUZEUVR0QlFVTkJPMEZCUTBFN1FVRkRRVHRCUVVOQk8wRkJRMEU3UVVGRFFUdEJRVU5CTzBGQlEwRTdRVUZEUVR0QlFVTkJPMEZCUTBFN1FVRkRRVHRCUVVOQk8wRkJRMEU3UVVGRFFUdEJRVU5CTzBGQlEwRTdRVUZEUVR0QlFVTkJPMEZCUTBFN1FVRkRRVHRCUVVOQk8wRkJRMEU3UVVGRFFUdEJRVU5CTzBGQlEwRTdRVUZEUVR0QlFVTkJPMEZCUTBFN1FVRkRRVHRCUVVOQk8wRkJRMEU3UVVGRFFUdEJRVU5CTzBGQlEwRTdRVUZEUVR0QlFVTkJPMEZCUTBFN1FVRkRRVHRCUVVOQk8wRkJRMEU3UVVGRFFUdEJRVU5CTzBGQlEwRTdRVUZEUVR0QlFVTkJPMEZCUTBFN1FVRkRRVHRCUVVOQk8wRkJRMEU3UVVGRFFUdEJRVU5CTzBGQlEwRTdRVUZEUVR0QlFVTkJPMEZCUTBFN1FVRkRRVHRCUVVOQk8wRkJRMEU3UVVGRFFUdEJRVU5CTzBGQlEwRTdRVUZEUVR0QlFVTkJPMEZCUTBFN1FVRkRRVHRCUVVOQk8wRkJRMEU3UVVGRFFUdEJRVU5CTzBGQlEwRTdRVUZEUVR0QlFVTkJPMEZCUTBFN1FVRkRRVHRCUVVOQk8wRkJRMEU3UVVGRFFUdEJRVU5CTzBGQlEwRTdRVUZEUVR0QlFVTkJPMEZCUTBFN1FVRkRRVHRCUVVOQk8wRkJRMEU3UVVGRFFUdEJRVU5CTzBGQlEwRTdRVUZEUVR0QlFVTkJPMEZCUTBFN1FVRkRRVHRCUVVOQk8wRkJRMEU3UVVGRFFUdEJRVU5CTzBGQlEwRTdRVUZEUVR0QlFVTkJPMEZCUTBFN1FVRkRRVHRCUVVOQk8wRkJRMEU3UVVGRFFUdEJRVU5CTzBGQlEwRTdRVUZEUVR0QlFVTkJPMEZCUTBFN1FVRkRRVHRCUVVOQk8wRkJRMEU3UVVGRFFUdEJRVU5CTzBGQlEwRTdRVUZEUVR0QlFVTkJPMEZCUTBFN1FVRkRRVHRCUVVOQk8wRkJRMEU3UVVGRFFUdEJRVU5CTzBGQlEwRTdRVUZEUVR0QlFVTkJPMEZCUTBFN1FVRkRRVHRCUVVOQk8wRkJRMEU3UVVGRFFUdEJRVU5CTzBGQlEwRTdRVUZEUVR0QlFVTkJPMEZCUTBFN1FVRkRRVHRCUVVOQk8wRkJRMEU3UVVGRFFUdEJRVU5CTzBGQlEwRTdRVUZEUVR0QlFVTkJPMEZCUTBFN1FVRkRRVHRCUVVOQk8wRkJRMEU3UVVGRFFUdEJRVU5CTzBGQlEwRTdRVUZEUVR0QlFVTkJPMEZCUTBFN1FVRkRRVHRCUVVOQk8wRkJRMEU3UVVGRFFUdEJRVU5CTzBGQlEwRTdRVUZEUVR0QlFVTkJPMEZCUTBFN1FVRkRRVHRCUVVOQk8wRkJRMEU3UVVGRFFUdEJRVU5CTzBGQlEwRTdRVUZEUVR0QlFVTkJPMEZCUTBFN1FVRkRRVHRCUVVOQk8wRkJRMEU3UVVGRFFUdEJRVU5CTzBGQlEwRTdRVUZEUVR0QlFVTkJPMEZCUTBFN1FVRkRRVHRCUVVOQk8wRkJRMEU3UVVGRFFUdEJRVU5CTzBGQlEwRTdRVUZEUVR0QlFVTkJPMEZCUTBFN1FVRkRRVHRCUVVOQk8wRkJRMEU3UVVGRFFUdEJRVU5CTzBGQlEwRTdRVUZEUVR0QlFVTkJPMEZCUTBFN1FVRkRRVHRCUVVOQk8wRkJRMEU3UVVGRFFUdEJRVU5CTzBGQlEwRTdRVUZEUVR0QlFVTkJPMEZCUTBFN1FVRkRRVHRCUVVOQk8wRkJRMEU3UVVGRFFUdEJRVU5CTzBGQlEwRTdRVUZEUVR0QlFVTkJPMEZCUTBFN1FVRkRRVHRCUVVOQk8wRkJRMEU3UVVGRFFUdEJRVU5CTzBGQlEwRTdRVUZEUVR0QlFVTkJPMEZCUTBFN1FVRkRRVHRCUVVOQk8wRkJRMEU3UVVGRFFUdEJRVU5CTzBGQlEwRTdRVUZEUVR0QlFVTkJPMEZCUTBFN1FVRkRRVHRCUVVOQk8wRkJRMEU3UVVGRFFUdEJRVU5CTzBGQlEwRTdRVUZEUVR0QlFVTkJPMEZCUTBFN1FVRkRRVHRCUVVOQk8wRkJRMEU3UVVGRFFUdEJRVU5CTzBGQlEwRTdRVUZEUVR0QlFVTkJPMEZCUTBFN1FVRkRRVHRCUVVOQk8wRkJRMEU3UVVGRFFUdEJRVU5CTzBGQlEwRTdRVUZEUVR0QlFVTkJPMEZCUTBFN1FVRkRRVHRCUVVOQk8wRkJRMEU3UVVGRFFUdEJRVU5CTzBGQlEwRTdRVUZEUVR0QlFVTkJPMEZCUTBFN1FVRkRRVHRCUVVOQk8wRkJRMEU3UVVGRFFUdEJRVU5CTzBGQlEwRTdRVUZEUVR0QlFVTkJPMEZCUTBFN1FVRkRRVHRCUVVOQk8wRkJRMEU3UVVGRFFUdEJRVU5CTzBGQlEwRTdRVUZEUVR0QlFVTkJPMEZCUTBFN1FVRkRRVHRCUVVOQk8wRkJRMEU3UVVGRFFUdEJRVU5CTzBGQlEwRTdRVUZEUVR0QlFVTkJPMEZCUTBFN1FVRkRRVHRCUVVOQk8wRkJRMEU3UVVGRFFUdEJRVU5CTzBGQlEwRTdRVUZEUVR0QlFVTkJPMEZCUTBFN1FVRkRRVHRCUVVOQk8wRkJRMEU3UVVGRFFUdEJRVU5CTzBGQlEwRTdRVUZEUVR0QlFVTkJPMEZCUTBFN1FVRkRRVHRCUVVOQk8wRkJRMEU3UVVGRFFUdEJRVU5CTzBGQlEwRTdRVUZEUVR0QlFVTkJPMEZCUTBFN1FVRkRRVHRCUVVOQk8wRkJRMEU3UVVGRFFUdEJRVU5CTzBGQlEwRTdRVUZEUVR0QlFVTkJPMEZCUTBFN1FVRkRRVHRCUVVOQk8wRkJRMEU3UVVGRFFUdEJRVU5CTzBGQlEwRTdRVUZEUVR0QlFVTkJPMEZCUTBFN1FVRkRRVHRCUVVOQk8wRkJRMEU3UVVGRFFUdEJRVU5CTzBGQlEwRTdRVUZEUVR0QlFVTkJPMEZCUTBFN1FVRkRRVHRCUVVOQk8wRkJRMEU3UVVGRFFUdEJRVU5CTzBGQlEwRTdRVUZEUVR0QlFVTkJPMEZCUTBFN1FVRkRRVHRCUVVOQk8wRkJRMEU3UVVGRFFUdEJRVU5CTzBGQlEwRTdRVUZEUVR0QlFVTkJPMEZCUTBFN1FVRkRRVHRCUVVOQk8wRkJRMEU3UVVGRFFUdEJRVU5CTzBGQlEwRTdRVUZEUVR0QlFVTkJPMEZCUTBFN1FVRkRRVHRCUVVOQk8wRkJRMEU3UVVGRFFUdEJRVU5CTzBGQlEwRTdRVUZEUVR0QlFVTkJPMEZCUTBFN1FVRkRRVHRCUVVOQk8wRkJRMEU3UVVGRFFUdEJRVU5CTzBGQlEwRTdRVUZEUVR0QlFVTkJPMEZCUTBFN1FVRkRRVHRCUVVOQk8wRkJRMEU3UVVGRFFUdEJRVU5CTzBGQlEwRTdRVUZEUVR0QlFVTkJPMEZCUTBFN1FVRkRRVHRCUVVOQk8wRkJRMEU3UVVGRFFUdEJRVU5CTzBGQlEwRTdRVUZEUVR0QlFVTkJPMEZCUTBFN1FVRkRRVHRCUVVOQk8wRkJRMEU3UVVGRFFUdEJRVU5CTzBGQlEwRTdRVUZEUVR0QlFVTkJPMEZCUTBFN1FVRkRRVHRCUVVOQk8wRkJRMEU3UVVGRFFUdEJRVU5CTzBGQlEwRTdRVUZEUVR0QlFVTkJPMEZCUTBFN1FVRkRRVHRCUVVOQk8wRkJRMEU3UVVGRFFUdEJRVU5CTzBGQlEwRTdRVUZEUVR0QlFVTkJPMEZCUTBFN1FVRkRRVHRCUVVOQk8wRkJRMEU3UVVGRFFUdEJRVU5CTzBGQlEwRTdRVUZEUVR0QlFVTkJPMEZCUTBFN1FVRkRRVHRCUVVOQk8wRkJRMEU3UVVGRFFUdEJRVU5CTzBGQlEwRTdRVUZEUVR0QlFVTkJPMEZCUTBFN1FVRkRRVHRCUVVOQk8wRkJRMEU3UVVGRFFUdEJRVU5CTzBGQlEwRTdRVUZEUVR0QlFVTkJPMEZCUTBFN1FVRkRRVHRCUVVOQk8wRkJRMEU3UVVGRFFUdEJRVU5CTzBGQlEwRTdRVUZEUVR0QlFVTkJPMEZCUTBFN1FVRkRRVHRCUVVOQk8wRkJRMEU3UVVGRFFUdEJRVU5CTzBGQlEwRTdRVUZEUVR0QlFVTkJPMEZCUTBFN1FVRkRRVHRCUVVOQk8wRkJRMEU3UVVGRFFUdEJRVU5CTzBGQlEwRTdRVUZEUVR0QlFVTkJPMEZCUTBFN1FVRkRRVHRCUVVOQk8wRkJRMEU3UVVGRFFUdEJRVU5CTzBGQlEwRTdRVUZEUVR0QlFVTkJPMEZCUTBFN1FVRkRRVHRCUVVOQk8wRkJRMEU3UVVGRFFUdEJRVU5CTzBGQlEwRTdRVUZEUVR0QlFVTkJPMEZCUTBFN1FVRkRRVHRCUVVOQk96czdPMEZEZEhSQ1FTeEpRVUZOTEd0Q1FVRnJRaXhIUVVGSExFOUJRVThzUTBGQlF5eHhRa0ZCUkN4RFFVRnNRenM3UVVGRlFTeEpRVUZOTEU5QlFVOHNSMEZCUnl4UlFVRlJMRU5CUVVNc1lVRkJWQ3hEUVVGMVFpeFBRVUYyUWl4RFFVRm9RanRCUVVOQkxFbEJRVTBzVlVGQlZTeEhRVUZITEZGQlFWRXNRMEZCUXl4alFVRlVMRU5CUVhkQ0xGbEJRWGhDTEVOQlFXNUNPMEZCUTBFc1NVRkJUU3hSUVVGUkxFZEJRVWNzVVVGQlVTeERRVUZETEdOQlFWUXNRMEZCZDBJc1ZVRkJlRUlzUTBGQmFrSTdRVUZEUVN4SlFVRk5MRTFCUVUwc1IwRkJSeXhSUVVGUkxFTkJRVU1zWTBGQlZDeERRVUYzUWl4UlFVRjRRaXhEUVVGbU8wRkJRMEVzU1VGQlRTeFZRVUZWTEVkQlFVY3NVVUZCVVN4RFFVRkRMR05CUVZRc1EwRkJkMElzV1VGQmVFSXNRMEZCYmtJN1FVRkRRU3hKUVVGTkxFOUJRVThzUjBGQlJ5eFJRVUZSTEVOQlFVTXNZMEZCVkN4RFFVRjNRaXhUUVVGNFFpeERRVUZvUWp0QlFVTkJMRWxCUVUwc1UwRkJVeXhIUVVGSExGRkJRVkVzUTBGQlF5eGpRVUZVTEVOQlFYZENMRmRCUVhoQ0xFTkJRV3hDTzBGQlEwRXNTVUZCVFN4VFFVRlRMRWRCUVVjc1VVRkJVU3hEUVVGRExHTkJRVlFzUTBGQmQwSXNWMEZCZUVJc1EwRkJiRUk3UVVGRFFTeEpRVUZOTEZOQlFWTXNSMEZCUnl4UlFVRlJMRU5CUVVNc1kwRkJWQ3hEUVVGM1FpeFhRVUY0UWl4RFFVRnNRanRCUVVOQkxFbEJRVTBzVTBGQlV5eEhRVUZITEZGQlFWRXNRMEZCUXl4alFVRlVMRU5CUVhkQ0xGZEJRWGhDTEVOQlFXeENPMEZCUTBFc1NVRkJUU3hUUVVGVExFZEJRVWNzVVVGQlVTeERRVUZETEdOQlFWUXNRMEZCZDBJc1YwRkJlRUlzUTBGQmJFSTdRVUZEUVN4SlFVRk5MRk5CUVZNc1IwRkJSeXhSUVVGUkxFTkJRVU1zWTBGQlZDeERRVUYzUWl4WFFVRjRRaXhEUVVGc1FqdEJRVU5CTEVsQlFVMHNVMEZCVXl4SFFVRkhMRkZCUVZFc1EwRkJReXhqUVVGVUxFTkJRWGRDTEZkQlFYaENMRU5CUVd4Q08wRkJRMEVzU1VGQlRTeFZRVUZWTEVkQlFVY3NVVUZCVVN4RFFVRkRMR05CUVZRc1EwRkJkMElzV1VGQmVFSXNRMEZCYmtJN1FVRkRRU3hKUVVGTkxFdEJRVXNzUjBGQlJ5eFJRVUZSTEVOQlFVTXNZMEZCVkN4RFFVRjNRaXhQUVVGNFFpeERRVUZrTzBGQlEwRXNTVUZCVFN4VlFVRlZMRWRCUVVjc1VVRkJVU3hEUVVGRExHTkJRVlFzUTBGQmQwSXNXVUZCZUVJc1EwRkJia0k3UVVGRFFTeEpRVUZKTEU5QlFVOHNSMEZCUnl4RFFVRmtPMEZCUTBFc1NVRkJTU3hOUVVGTkxFZEJRVWNzUTBGQllqdEJRVU5CTEVsQlFVMHNVVUZCVVN4SFFVRkhMRU5CUTJZN1FVRkRSU3hGUVVGQkxFZEJRVWNzUlVGQlJTeHRRa0ZFVUR0QlFVVkZMRVZCUVVFc1VVRkJVU3hGUVVGRkxIZENRVVphTzBGQlIwVXNSVUZCUVN4SlFVRkpMRVZCUTBZN1FVRktTaXhEUVVSbExFVkJUMlk3UVVGRFJTeEZRVUZCTEVkQlFVY3NSVUZCUlN4dFFrRkVVRHRCUVVWRkxFVkJRVUVzVVVGQlVTeEZRVUZGTEcxQ1FVWmFPMEZCUjBVc1JVRkJRU3hKUVVGSkxFVkJRMFk3UVVGS1NpeERRVkJsTEVWQllXWTdRVUZEUlN4RlFVRkJMRWRCUVVjc1JVRkJSU3h4UWtGRVVEdEJRVVZGTEVWQlFVRXNVVUZCVVN4RlFVRkZMRlZCUmxvN1FVRkhSU3hGUVVGQkxFbEJRVWtzUlVGRFJqdEJRVXBLTEVOQlltVXNSVUZ0UW1ZN1FVRkRSU3hGUVVGQkxFZEJRVWNzUlVGQlJTd3dRa0ZFVUR0QlFVVkZMRVZCUVVFc1VVRkJVU3hGUVVGRkxHVkJSbG83UVVGSFJTeEZRVUZCTEVsQlFVa3NSVUZEUmp0QlFVcEtMRU5CYmtKbExFVkJlVUptTzBGQlEwVXNSVUZCUVN4SFFVRkhMRVZCUVVVc2IwSkJSRkE3UVVGRlJTeEZRVUZCTEZGQlFWRXNSVUZCUlN4VFFVWmFPMEZCUjBVc1JVRkJRU3hKUVVGSkxFVkJRMFk3UVVGS1NpeERRWHBDWlN4RlFTdENaanRCUVVORkxFVkJRVUVzUjBGQlJ5eEZRVUZGTEcxQ1FVUlFPMEZCUlVVc1JVRkJRU3hSUVVGUkxFVkJRVVVzVVVGR1dqdEJRVWRGTEVWQlFVRXNTVUZCU1N4RlFVTkdPMEZCU2tvc1EwRXZRbVVzUlVGeFEyWTdRVUZEUlN4RlFVRkJMRWRCUVVjc1JVRkJSU3h4UWtGRVVEdEJRVVZGTEVWQlFVRXNVVUZCVVN4RlFVRkZMRlZCUmxvN1FVRkhSU3hGUVVGQkxFbEJRVWtzUlVGRFJqdEJRVXBLTEVOQmNrTmxMRVZCTWtObU8wRkJRMFVzUlVGQlFTeEhRVUZITEVWQlFVVXNhME5CUkZBN1FVRkZSU3hGUVVGQkxGRkJRVkVzUlVGQlJTeDFRa0ZHV2p0QlFVZEZMRVZCUVVFc1NVRkJTU3hGUVVOR08wRkJTa29zUTBFelEyVXNSVUZwUkdZN1FVRkRSU3hGUVVGQkxFZEJRVWNzUlVGQlJTdzBRa0ZFVUR0QlFVVkZMRVZCUVVFc1VVRkJVU3hGUVVGRkxHbENRVVphTzBGQlIwVXNSVUZCUVN4SlFVRkpMRVZCUTBZN1FVRktTaXhEUVdwRVpTeERRVUZxUWp0QlFYbEVRU3hSUVVGUkxFTkJRVU1zWjBKQlFWUXNRMEZCTUVJc1VVRkJNVUlzUlVGQmIwTXNXVUZCVFR0QlFVTjRReXhOUVVGSkxFMUJRVTBzUTBGQlF5eFhRVUZRTEVkQlFYRkNMRTlCUVU4c1EwRkJReXhaUVVGcVF5eEZRVUVyUXp0QlFVTTNReXhKUVVGQkxFOUJRVThzUTBGQlF5eFRRVUZTTEVOQlFXdENMRTFCUVd4Q0xFTkJRWGxDTEU5QlFYcENPMEZCUTBRc1IwRkdSQ3hOUVVWUE8wRkJRMHdzU1VGQlFTeFBRVUZQTEVOQlFVTXNVMEZCVWl4RFFVRnJRaXhIUVVGc1FpeERRVUZ6UWl4UFFVRjBRanRCUVVORU8wRkJRMFlzUTBGT1JEczdRVUZSUVN4TlFVRk5MRU5CUVVNc1QwRkJVQ3hIUVVGcFFpeFZRVUZCTEVOQlFVTXNSVUZCU1R0QlFVTndRaXhGUVVGQkxFTkJRVU1zUTBGQlF5eGpRVUZHTzBGQlEwRXNSVUZCUVN4VlFVRlZMRU5CUVVNc1UwRkJXQ3hEUVVGeFFpeE5RVUZ5UWl4RFFVRTBRaXhOUVVFMVFqdEJRVU5FTEVOQlNFUTdPMEZCUzBFc1VVRkJVU3hEUVVGRExFOUJRVlFzUjBGQmJVSXNWVUZCUVN4RFFVRkRMRVZCUVVrN1FVRkRkRUlzUlVGQlFTeERRVUZETEVOQlFVTXNZMEZCUmp0QlFVTkJMRVZCUVVFc1ZVRkJWU3hEUVVGRExGTkJRVmdzUTBGQmNVSXNUVUZCY2tJc1EwRkJORUlzVFVGQk5VSTdRVUZEUkN4RFFVaEVPenRCUVV0QkxGVkJRVlVzUTBGQlF5eFBRVUZZTEVkQlFYRkNMRmxCUVUwN1FVRkRla0lzUlVGQlFTeFZRVUZWTEVOQlFVTXNVMEZCV0N4RFFVRnhRaXhOUVVGeVFpeERRVUUwUWl4TlFVRTFRanRCUVVORUxFTkJSa1FzUXl4RFFVbEJPMEZCUTBFN1FVRkRRVHRCUVVOQk8wRkJRMEU3UVVGRFFUdEJRVU5CTzBGQlEwRTdRVUZEUVR0QlFVTkJPMEZCUTBFN1FVRkZRVHRCUVVOQk8wRkJRMEU3UVVGRFFUdEJRVU5CTzBGQlEwRTdRVUZEUVR0QlFVTkJPMEZCUTBFN1FVRkRRVHM3TzBGQlJVRXNVMEZCVXl4RFFVRkRMRTlCUVZZc1IwRkJiMElzV1VGQlRUdEJRVU40UWl4RlFVRkJMRk5CUVZNc1EwRkJReXhUUVVGV0xFTkJRVzlDTEUxQlFYQkNMRU5CUVRKQ0xFMUJRVE5DTzBGQlEwRXNSVUZCUVN4VFFVRlRMRU5CUVVNc1UwRkJWaXhEUVVGdlFpeE5RVUZ3UWl4RFFVRXlRaXhOUVVFelFqdEJRVU5CTEVWQlFVRXNVMEZCVXl4RFFVRkRMRk5CUVZZc1EwRkJiMElzVFVGQmNFSXNRMEZCTWtJc1VVRkJNMEk3UVVGRFFTeEZRVUZCTEZOQlFWTXNRMEZCUXl4VFFVRldMRU5CUVc5Q0xFMUJRWEJDTEVOQlFUSkNMRkZCUVROQ08wRkJRMFFzUTBGTVJEczdRVUZQUVN4VFFVRlRMRU5CUVVNc1QwRkJWaXhIUVVGdlFpeFpRVUZOTzBGQlEzaENMRVZCUVVFc1UwRkJVeXhEUVVGRExGTkJRVllzUTBGQmIwSXNUVUZCY0VJc1EwRkJNa0lzVFVGQk0wSTdRVUZEUVN4RlFVRkJMRk5CUVZNc1EwRkJReXhUUVVGV0xFTkJRVzlDTEUxQlFYQkNMRU5CUVRKQ0xFMUJRVE5DTzBGQlEwRXNSVUZCUVN4VFFVRlRMRU5CUVVNc1UwRkJWaXhEUVVGdlFpeE5RVUZ3UWl4RFFVRXlRaXhSUVVFelFqdEJRVU5CTEVWQlFVRXNVMEZCVXl4RFFVRkRMRk5CUVZZc1EwRkJiMElzVFVGQmNFSXNRMEZCTWtJc1VVRkJNMEk3UVVGRFJDeERRVXhFTEVNc1EwRlBRVHRCUVVOQk8wRkJRMEU3UVVGRFFUdEJRVU5CTzBGQlJVRTdRVUZEUVR0QlFVTkJPMEZCUTBFN1FVRkRRVHM3TzBGQlJVRXNTVUZCVFN4alFVRmpMRWRCUVVjc1UwRkJha0lzWTBGQmFVSXNRMEZCUVN4SlFVRkpMRVZCUVVrN1FVRkROMElzYlVwQlJXbEVMRWxCUVVrc1EwRkJReXhIUVVaMFJDeG5TRUZKY1VNc1NVRkJTU3hEUVVGRExGRkJTakZETEhORVFVdG5ReXhKUVVGSkxFTkJRVU1zU1VGTWNrTTdRVUZUUkN4RFFWWkVPenRCUVZsQkxFbEJRVWtzWVVGQllTeEhRVUZITEZOQlFXaENMR0ZCUVdkQ0xFTkJRVUVzV1VGQldTeEZRVUZKTzBGQlEyeERMRTFCUVUwc1VVRkJVU3hIUVVGSExGbEJRVmtzUTBGQlF5eEhRVUZpTEVOQlFXbENMRlZCUVVFc1QwRkJUenRCUVVGQkxGZEJRVWtzWTBGQll5eERRVUZETEU5QlFVUXNRMEZCYkVJN1FVRkJRU3hIUVVGNFFpeERRVUZxUWp0QlFVTkJMRVZCUVVFc1VVRkJVU3hEUVVGRExHTkJRVlFzUTBGQmQwSXNaMEpCUVhoQ0xFVkJRVEJETEZOQlFURkRMRWRCUVhORUxGRkJRVkVzUTBGQlF5eEpRVUZVTEVOQlFXTXNSVUZCWkN4RFFVRjBSRHRCUVVORUxFTkJTRVE3TzBGQlMwRXNUMEZCVHl4RFFVRkRMRTlCUVZJc1IwRkJhMElzVlVGQlFTeERRVUZETEVWQlFVazdRVUZEY2tJc1JVRkJRU3hEUVVGRExFTkJRVU1zWTBGQlJqdEJRVU5CTEVWQlFVRXNUMEZCVHl4SlFVRkpMRTFCUVZnN1FVRkRRU3hGUVVGQkxHRkJRV0VzUTBGQlF5eFJRVUZSTEVOQlFVTXNTMEZCVkN4RFFVRmxMRU5CUVdZc1JVRkJhMElzVDBGQmJFSXNRMEZCUkN4RFFVRmlPMEZCUTBRc1EwRktSRHM3UVVGTlFTeE5RVUZOTEVOQlFVTXNaMEpCUVZBc1EwRkJkMElzYTBKQlFYaENMRVZCUVRSRExGbEJRVTA3UVVGRGFFUXNUVUZCVFN4WlFVRlpMRWRCUVVjc1UwRkJaaXhaUVVGbE8wRkJRVUU3UVVGQlFUdEJRVUZCTzBGQlFVRTdRVUZCUVN3d1FrRkRXQ3hKUVVSWE8wRkJRVUVzTkVOQlJWb3NVVUZCVVN4RFFVRkRMR1ZCUVZRc1EwRkJlVUlzVjBGQmVrSXNSMEZCZFVNc1IwRkdNMElzZFVKQlMxb3NVVUZCVVN4RFFVRkRMR1ZCUVZRc1EwRkJlVUlzVjBGQmVrSXNSMEZCZFVNc1IwRk1NMEk3UVVGQlFUczdRVUZCUVR0QlFVZG1MRmxCUVVFc1QwRkJUeXhIUVVGSExFTkJRVlk3UVVGSVpUczdRVUZCUVR0QlFVMW1MRmxCUVVFc1QwRkJUeXhIUVVGSExFTkJRVlk3UVVGRFFTeFpRVUZCTEUxQlFVMHNSMEZCUnl4RFFVRlVPMEZCVUdVN08wRkJRVUU3UVVGVlppeFpRVUZCTEU5QlFVOHNSMEZCUnl4RFFVRldPMEZCUTBFc1dVRkJRU3hOUVVGTkxFZEJRVWNzUTBGQlZEdEJRVmhsT3p0QlFVRkJPMEZCUVVFN1FVRkJRVHRCUVVGQk8wRkJRVUU3UVVGQlFUdEJRVUZCTEVkQlFYSkNPenRCUVdWQkxFVkJRVUVzV1VGQldUdEJRVU5hTEVWQlFVRXNZVUZCWVN4RFFVRkRMRkZCUVZFc1EwRkJReXhMUVVGVUxFTkJRV1VzUTBGQlppeEZRVUZyUWl4UFFVRnNRaXhEUVVGRUxFTkJRV0k3UVVGRFJDeERRV3hDUkNJc0ltWnBiR1VpT2lKblpXNWxjbUYwWldRdWFuTWlMQ0p6YjNWeVkyVlNiMjkwSWpvaUlpd2ljMjkxY21ObGMwTnZiblJsYm5RaU9sc2lLR1oxYm1OMGFXOXVLQ2w3Wm5WdVkzUnBiMjRnY2lobExHNHNkQ2w3Wm5WdVkzUnBiMjRnYnlocExHWXBlMmxtS0NGdVcybGRLWHRwWmlnaFpWdHBYU2w3ZG1GeUlHTTlYQ0ptZFc1amRHbHZibHdpUFQxMGVYQmxiMllnY21WeGRXbHlaU1ltY21WeGRXbHlaVHRwWmlnaFppWW1ZeWx5WlhSMWNtNGdZeWhwTENFd0tUdHBaaWgxS1hKbGRIVnliaUIxS0drc0lUQXBPM1poY2lCaFBXNWxkeUJGY25KdmNpaGNJa05oYm01dmRDQm1hVzVrSUcxdlpIVnNaU0FuWENJcmFTdGNJaWRjSWlrN2RHaHliM2NnWVM1amIyUmxQVndpVFU5RVZVeEZYMDVQVkY5R1QxVk9SRndpTEdGOWRtRnlJSEE5Ymx0cFhUMTdaWGh3YjNKMGN6cDdmWDA3WlZ0cFhWc3dYUzVqWVd4c0tIQXVaWGh3YjNKMGN5eG1kVzVqZEdsdmJpaHlLWHQyWVhJZ2JqMWxXMmxkV3pGZFczSmRPM0psZEhWeWJpQnZLRzU4ZkhJcGZTeHdMSEF1Wlhod2IzSjBjeXh5TEdVc2JpeDBLWDF5WlhSMWNtNGdibHRwWFM1bGVIQnZjblJ6ZldadmNpaDJZWElnZFQxY0ltWjFibU4wYVc5dVhDSTlQWFI1Y0dWdlppQnlaWEYxYVhKbEppWnlaWEYxYVhKbExHazlNRHRwUEhRdWJHVnVaM1JvTzJrckt5bHZLSFJiYVYwcE8zSmxkSFZ5YmlCdmZYSmxkSFZ5YmlCeWZTa29LU0lzSWk4cUtseHVJQ29nUTI5d2VYSnBaMmgwSUNoaktTQXlNREUwTFhCeVpYTmxiblFzSUVaaFkyVmliMjlyTENCSmJtTXVYRzRnS2x4dUlDb2dWR2hwY3lCemIzVnlZMlVnWTI5a1pTQnBjeUJzYVdObGJuTmxaQ0IxYm1SbGNpQjBhR1VnVFVsVUlHeHBZMlZ1YzJVZ1ptOTFibVFnYVc0Z2RHaGxYRzRnS2lCTVNVTkZUbE5GSUdacGJHVWdhVzRnZEdobElISnZiM1FnWkdseVpXTjBiM0o1SUc5bUlIUm9hWE1nYzI5MWNtTmxJSFJ5WldVdVhHNGdLaTljYmx4dWRtRnlJSEoxYm5ScGJXVWdQU0FvWm5WdVkzUnBiMjRnS0dWNGNHOXlkSE1wSUh0Y2JpQWdYQ0oxYzJVZ2MzUnlhV04wWENJN1hHNWNiaUFnZG1GeUlFOXdJRDBnVDJKcVpXTjBMbkJ5YjNSdmRIbHdaVHRjYmlBZ2RtRnlJR2hoYzA5M2JpQTlJRTl3TG1oaGMwOTNibEJ5YjNCbGNuUjVPMXh1SUNCMllYSWdkVzVrWldacGJtVmtPeUF2THlCTmIzSmxJR052YlhCeVpYTnphV0pzWlNCMGFHRnVJSFp2YVdRZ01DNWNiaUFnZG1GeUlDUlRlVzFpYjJ3Z1BTQjBlWEJsYjJZZ1UzbHRZbTlzSUQwOVBTQmNJbVoxYm1OMGFXOXVYQ0lnUHlCVGVXMWliMndnT2lCN2ZUdGNiaUFnZG1GeUlHbDBaWEpoZEc5eVUzbHRZbTlzSUQwZ0pGTjViV0p2YkM1cGRHVnlZWFJ2Y2lCOGZDQmNJa0JBYVhSbGNtRjBiM0pjSWp0Y2JpQWdkbUZ5SUdGemVXNWpTWFJsY21GMGIzSlRlVzFpYjJ3Z1BTQWtVM2x0WW05c0xtRnplVzVqU1hSbGNtRjBiM0lnZkh3Z1hDSkFRR0Z6ZVc1alNYUmxjbUYwYjNKY0lqdGNiaUFnZG1GeUlIUnZVM1J5YVc1blZHRm5VM2x0WW05c0lEMGdKRk41YldKdmJDNTBiMU4wY21sdVoxUmhaeUI4ZkNCY0lrQkFkRzlUZEhKcGJtZFVZV2RjSWp0Y2JseHVJQ0JtZFc1amRHbHZiaUIzY21Gd0tHbHVibVZ5Um00c0lHOTFkR1Z5Um00c0lITmxiR1lzSUhSeWVVeHZZM05NYVhOMEtTQjdYRzRnSUNBZ0x5OGdTV1lnYjNWMFpYSkdiaUJ3Y205MmFXUmxaQ0JoYm1RZ2IzVjBaWEpHYmk1d2NtOTBiM1I1Y0dVZ2FYTWdZU0JIWlc1bGNtRjBiM0lzSUhSb1pXNGdiM1YwWlhKR2JpNXdjbTkwYjNSNWNHVWdhVzV6ZEdGdVkyVnZaaUJIWlc1bGNtRjBiM0l1WEc0Z0lDQWdkbUZ5SUhCeWIzUnZSMlZ1WlhKaGRHOXlJRDBnYjNWMFpYSkdiaUFtSmlCdmRYUmxja1p1TG5CeWIzUnZkSGx3WlNCcGJuTjBZVzVqWlc5bUlFZGxibVZ5WVhSdmNpQS9JRzkxZEdWeVJtNGdPaUJIWlc1bGNtRjBiM0k3WEc0Z0lDQWdkbUZ5SUdkbGJtVnlZWFJ2Y2lBOUlFOWlhbVZqZEM1amNtVmhkR1VvY0hKdmRHOUhaVzVsY21GMGIzSXVjSEp2ZEc5MGVYQmxLVHRjYmlBZ0lDQjJZWElnWTI5dWRHVjRkQ0E5SUc1bGR5QkRiMjUwWlhoMEtIUnllVXh2WTNOTWFYTjBJSHg4SUZ0ZEtUdGNibHh1SUNBZ0lDOHZJRlJvWlNBdVgybHVkbTlyWlNCdFpYUm9iMlFnZFc1cFptbGxjeUIwYUdVZ2FXMXdiR1Z0Wlc1MFlYUnBiMjV6SUc5bUlIUm9aU0F1Ym1WNGRDeGNiaUFnSUNBdkx5QXVkR2h5YjNjc0lHRnVaQ0F1Y21WMGRYSnVJRzFsZEdodlpITXVYRzRnSUNBZ1oyVnVaWEpoZEc5eUxsOXBiblp2YTJVZ1BTQnRZV3RsU1c1MmIydGxUV1YwYUc5a0tHbHVibVZ5Um00c0lITmxiR1lzSUdOdmJuUmxlSFFwTzF4dVhHNGdJQ0FnY21WMGRYSnVJR2RsYm1WeVlYUnZjanRjYmlBZ2ZWeHVJQ0JsZUhCdmNuUnpMbmR5WVhBZ1BTQjNjbUZ3TzF4dVhHNGdJQzh2SUZSeWVTOWpZWFJqYUNCb1pXeHdaWElnZEc4Z2JXbHVhVzFwZW1VZ1pHVnZjSFJwYldsNllYUnBiMjV6TGlCU1pYUjFjbTV6SUdFZ1kyOXRjR3hsZEdsdmJseHVJQ0F2THlCeVpXTnZjbVFnYkdsclpTQmpiMjUwWlhoMExuUnllVVZ1ZEhKcFpYTmJhVjB1WTI5dGNHeGxkR2x2Ymk0Z1ZHaHBjeUJwYm5SbGNtWmhZMlVnWTI5MWJHUmNiaUFnTHk4Z2FHRjJaU0JpWldWdUlDaGhibVFnZDJGeklIQnlaWFpwYjNWemJIa3BJR1JsYzJsbmJtVmtJSFJ2SUhSaGEyVWdZU0JqYkc5emRYSmxJSFJ2SUdKbFhHNGdJQzh2SUdsdWRtOXJaV1FnZDJsMGFHOTFkQ0JoY21kMWJXVnVkSE1zSUdKMWRDQnBiaUJoYkd3Z2RHaGxJR05oYzJWeklIZGxJR05oY21VZ1lXSnZkWFFnZDJWY2JpQWdMeThnWVd4eVpXRmtlU0JvWVhabElHRnVJR1Y0YVhOMGFXNW5JRzFsZEdodlpDQjNaU0IzWVc1MElIUnZJR05oYkd3c0lITnZJSFJvWlhKbEozTWdibThnYm1WbFpGeHVJQ0F2THlCMGJ5QmpjbVZoZEdVZ1lTQnVaWGNnWm5WdVkzUnBiMjRnYjJKcVpXTjBMaUJYWlNCallXNGdaWFpsYmlCblpYUWdZWGRoZVNCM2FYUm9JR0Z6YzNWdGFXNW5YRzRnSUM4dklIUm9aU0J0WlhSb2IyUWdkR0ZyWlhNZ1pYaGhZM1JzZVNCdmJtVWdZWEpuZFcxbGJuUXNJSE5wYm1ObElIUm9ZWFFnYUdGd2NHVnVjeUIwYnlCaVpTQjBjblZsWEc0Z0lDOHZJR2x1SUdWMlpYSjVJR05oYzJVc0lITnZJSGRsSUdSdmJpZDBJR2hoZG1VZ2RHOGdkRzkxWTJnZ2RHaGxJR0Z5WjNWdFpXNTBjeUJ2WW1wbFkzUXVJRlJvWlZ4dUlDQXZMeUJ2Ym14NUlHRmtaR2wwYVc5dVlXd2dZV3hzYjJOaGRHbHZiaUJ5WlhGMWFYSmxaQ0JwY3lCMGFHVWdZMjl0Y0d4bGRHbHZiaUJ5WldOdmNtUXNJSGRvYVdOb1hHNGdJQzh2SUdoaGN5QmhJSE4wWVdKc1pTQnphR0Z3WlNCaGJtUWdjMjhnYUc5d1pXWjFiR3g1SUhOb2IzVnNaQ0JpWlNCamFHVmhjQ0IwYnlCaGJHeHZZMkYwWlM1Y2JpQWdablZ1WTNScGIyNGdkSEo1UTJGMFkyZ29abTRzSUc5aWFpd2dZWEpuS1NCN1hHNGdJQ0FnZEhKNUlIdGNiaUFnSUNBZ0lISmxkSFZ5YmlCN0lIUjVjR1U2SUZ3aWJtOXliV0ZzWENJc0lHRnlaem9nWm00dVkyRnNiQ2h2WW1vc0lHRnlaeWtnZlR0Y2JpQWdJQ0I5SUdOaGRHTm9JQ2hsY25JcElIdGNiaUFnSUNBZ0lISmxkSFZ5YmlCN0lIUjVjR1U2SUZ3aWRHaHliM2RjSWl3Z1lYSm5PaUJsY25JZ2ZUdGNiaUFnSUNCOVhHNGdJSDFjYmx4dUlDQjJZWElnUjJWdVUzUmhkR1ZUZFhOd1pXNWtaV1JUZEdGeWRDQTlJRndpYzNWemNHVnVaR1ZrVTNSaGNuUmNJanRjYmlBZ2RtRnlJRWRsYmxOMFlYUmxVM1Z6Y0dWdVpHVmtXV2xsYkdRZ1BTQmNJbk4xYzNCbGJtUmxaRmxwWld4a1hDSTdYRzRnSUhaaGNpQkhaVzVUZEdGMFpVVjRaV04xZEdsdVp5QTlJRndpWlhobFkzVjBhVzVuWENJN1hHNGdJSFpoY2lCSFpXNVRkR0YwWlVOdmJYQnNaWFJsWkNBOUlGd2lZMjl0Y0d4bGRHVmtYQ0k3WEc1Y2JpQWdMeThnVW1WMGRYSnVhVzVuSUhSb2FYTWdiMkpxWldOMElHWnliMjBnZEdobElHbHVibVZ5Um00Z2FHRnpJSFJvWlNCellXMWxJR1ZtWm1WamRDQmhjMXh1SUNBdkx5QmljbVZoYTJsdVp5QnZkWFFnYjJZZ2RHaGxJR1JwYzNCaGRHTm9JSE4zYVhSamFDQnpkR0YwWlcxbGJuUXVYRzRnSUhaaGNpQkRiMjUwYVc1MVpWTmxiblJwYm1Wc0lEMGdlMzA3WEc1Y2JpQWdMeThnUkhWdGJYa2dZMjl1YzNSeWRXTjBiM0lnWm5WdVkzUnBiMjV6SUhSb1lYUWdkMlVnZFhObElHRnpJSFJvWlNBdVkyOXVjM1J5ZFdOMGIzSWdZVzVrWEc0Z0lDOHZJQzVqYjI1emRISjFZM1J2Y2k1d2NtOTBiM1I1Y0dVZ2NISnZjR1Z5ZEdsbGN5Qm1iM0lnWm5WdVkzUnBiMjV6SUhSb1lYUWdjbVYwZFhKdUlFZGxibVZ5WVhSdmNseHVJQ0F2THlCdlltcGxZM1J6TGlCR2IzSWdablZzYkNCemNHVmpJR052YlhCc2FXRnVZMlVzSUhsdmRTQnRZWGtnZDJsemFDQjBieUJqYjI1bWFXZDFjbVVnZVc5MWNseHVJQ0F2THlCdGFXNXBabWxsY2lCdWIzUWdkRzhnYldGdVoyeGxJSFJvWlNCdVlXMWxjeUJ2WmlCMGFHVnpaU0IwZDI4Z1puVnVZM1JwYjI1ekxseHVJQ0JtZFc1amRHbHZiaUJIWlc1bGNtRjBiM0lvS1NCN2ZWeHVJQ0JtZFc1amRHbHZiaUJIWlc1bGNtRjBiM0pHZFc1amRHbHZiaWdwSUh0OVhHNGdJR1oxYm1OMGFXOXVJRWRsYm1WeVlYUnZja1oxYm1OMGFXOXVVSEp2ZEc5MGVYQmxLQ2tnZTMxY2JseHVJQ0F2THlCVWFHbHpJR2x6SUdFZ2NHOXNlV1pwYkd3Z1ptOXlJQ1ZKZEdWeVlYUnZjbEJ5YjNSdmRIbHdaU1VnWm05eUlHVnVkbWx5YjI1dFpXNTBjeUIwYUdGMFhHNGdJQzh2SUdSdmJpZDBJRzVoZEdsMlpXeDVJSE4xY0hCdmNuUWdhWFF1WEc0Z0lIWmhjaUJKZEdWeVlYUnZjbEJ5YjNSdmRIbHdaU0E5SUh0OU8xeHVJQ0JKZEdWeVlYUnZjbEJ5YjNSdmRIbHdaVnRwZEdWeVlYUnZjbE41YldKdmJGMGdQU0JtZFc1amRHbHZiaUFvS1NCN1hHNGdJQ0FnY21WMGRYSnVJSFJvYVhNN1hHNGdJSDA3WEc1Y2JpQWdkbUZ5SUdkbGRGQnliM1J2SUQwZ1QySnFaV04wTG1kbGRGQnliM1J2ZEhsd1pVOW1PMXh1SUNCMllYSWdUbUYwYVhabFNYUmxjbUYwYjNKUWNtOTBiM1I1Y0dVZ1BTQm5aWFJRY205MGJ5QW1KaUJuWlhSUWNtOTBieWhuWlhSUWNtOTBieWgyWVd4MVpYTW9XMTBwS1NrN1hHNGdJR2xtSUNoT1lYUnBkbVZKZEdWeVlYUnZjbEJ5YjNSdmRIbHdaU0FtSmx4dUlDQWdJQ0FnVG1GMGFYWmxTWFJsY21GMGIzSlFjbTkwYjNSNWNHVWdJVDA5SUU5d0lDWW1YRzRnSUNBZ0lDQm9ZWE5QZDI0dVkyRnNiQ2hPWVhScGRtVkpkR1Z5WVhSdmNsQnliM1J2ZEhsd1pTd2dhWFJsY21GMGIzSlRlVzFpYjJ3cEtTQjdYRzRnSUNBZ0x5OGdWR2hwY3lCbGJuWnBjbTl1YldWdWRDQm9ZWE1nWVNCdVlYUnBkbVVnSlVsMFpYSmhkRzl5VUhKdmRHOTBlWEJsSlRzZ2RYTmxJR2wwSUdsdWMzUmxZV1JjYmlBZ0lDQXZMeUJ2WmlCMGFHVWdjRzlzZVdacGJHd3VYRzRnSUNBZ1NYUmxjbUYwYjNKUWNtOTBiM1I1Y0dVZ1BTQk9ZWFJwZG1WSmRHVnlZWFJ2Y2xCeWIzUnZkSGx3WlR0Y2JpQWdmVnh1WEc0Z0lIWmhjaUJIY0NBOUlFZGxibVZ5WVhSdmNrWjFibU4wYVc5dVVISnZkRzkwZVhCbExuQnliM1J2ZEhsd1pTQTlYRzRnSUNBZ1IyVnVaWEpoZEc5eUxuQnliM1J2ZEhsd1pTQTlJRTlpYW1WamRDNWpjbVZoZEdVb1NYUmxjbUYwYjNKUWNtOTBiM1I1Y0dVcE8xeHVJQ0JIWlc1bGNtRjBiM0pHZFc1amRHbHZiaTV3Y205MGIzUjVjR1VnUFNCSGNDNWpiMjV6ZEhKMVkzUnZjaUE5SUVkbGJtVnlZWFJ2Y2taMWJtTjBhVzl1VUhKdmRHOTBlWEJsTzF4dUlDQkhaVzVsY21GMGIzSkdkVzVqZEdsdmJsQnliM1J2ZEhsd1pTNWpiMjV6ZEhKMVkzUnZjaUE5SUVkbGJtVnlZWFJ2Y2taMWJtTjBhVzl1TzF4dUlDQkhaVzVsY21GMGIzSkdkVzVqZEdsdmJsQnliM1J2ZEhsd1pWdDBiMU4wY21sdVoxUmhaMU41YldKdmJGMGdQVnh1SUNBZ0lFZGxibVZ5WVhSdmNrWjFibU4wYVc5dUxtUnBjM0JzWVhsT1lXMWxJRDBnWENKSFpXNWxjbUYwYjNKR2RXNWpkR2x2Ymx3aU8xeHVYRzRnSUM4dklFaGxiSEJsY2lCbWIzSWdaR1ZtYVc1cGJtY2dkR2hsSUM1dVpYaDBMQ0F1ZEdoeWIzY3NJR0Z1WkNBdWNtVjBkWEp1SUcxbGRHaHZaSE1nYjJZZ2RHaGxYRzRnSUM4dklFbDBaWEpoZEc5eUlHbHVkR1Z5Wm1GalpTQnBiaUIwWlhKdGN5QnZaaUJoSUhOcGJtZHNaU0F1WDJsdWRtOXJaU0J0WlhSb2IyUXVYRzRnSUdaMWJtTjBhVzl1SUdSbFptbHVaVWwwWlhKaGRHOXlUV1YwYUc5a2N5aHdjbTkwYjNSNWNHVXBJSHRjYmlBZ0lDQmJYQ0p1WlhoMFhDSXNJRndpZEdoeWIzZGNJaXdnWENKeVpYUjFjbTVjSWwwdVptOXlSV0ZqYUNobWRXNWpkR2x2YmlodFpYUm9iMlFwSUh0Y2JpQWdJQ0FnSUhCeWIzUnZkSGx3WlZ0dFpYUm9iMlJkSUQwZ1puVnVZM1JwYjI0b1lYSm5LU0I3WEc0Z0lDQWdJQ0FnSUhKbGRIVnliaUIwYUdsekxsOXBiblp2YTJVb2JXVjBhRzlrTENCaGNtY3BPMXh1SUNBZ0lDQWdmVHRjYmlBZ0lDQjlLVHRjYmlBZ2ZWeHVYRzRnSUdWNGNHOXlkSE11YVhOSFpXNWxjbUYwYjNKR2RXNWpkR2x2YmlBOUlHWjFibU4wYVc5dUtHZGxia1oxYmlrZ2UxeHVJQ0FnSUhaaGNpQmpkRzl5SUQwZ2RIbHdaVzltSUdkbGJrWjFiaUE5UFQwZ1hDSm1kVzVqZEdsdmJsd2lJQ1ltSUdkbGJrWjFiaTVqYjI1emRISjFZM1J2Y2p0Y2JpQWdJQ0J5WlhSMWNtNGdZM1J2Y2x4dUlDQWdJQ0FnUHlCamRHOXlJRDA5UFNCSFpXNWxjbUYwYjNKR2RXNWpkR2x2YmlCOGZGeHVJQ0FnSUNBZ0lDQXZMeUJHYjNJZ2RHaGxJRzVoZEdsMlpTQkhaVzVsY21GMGIzSkdkVzVqZEdsdmJpQmpiMjV6ZEhKMVkzUnZjaXdnZEdobElHSmxjM1FnZDJVZ1kyRnVYRzRnSUNBZ0lDQWdJQzh2SUdSdklHbHpJSFJ2SUdOb1pXTnJJR2wwY3lBdWJtRnRaU0J3Y205d1pYSjBlUzVjYmlBZ0lDQWdJQ0FnS0dOMGIzSXVaR2x6Y0d4aGVVNWhiV1VnZkh3Z1kzUnZjaTV1WVcxbEtTQTlQVDBnWENKSFpXNWxjbUYwYjNKR2RXNWpkR2x2Ymx3aVhHNGdJQ0FnSUNBNklHWmhiSE5sTzF4dUlDQjlPMXh1WEc0Z0lHVjRjRzl5ZEhNdWJXRnlheUE5SUdaMWJtTjBhVzl1S0dkbGJrWjFiaWtnZTF4dUlDQWdJR2xtSUNoUFltcGxZM1F1YzJWMFVISnZkRzkwZVhCbFQyWXBJSHRjYmlBZ0lDQWdJRTlpYW1WamRDNXpaWFJRY205MGIzUjVjR1ZQWmloblpXNUdkVzRzSUVkbGJtVnlZWFJ2Y2taMWJtTjBhVzl1VUhKdmRHOTBlWEJsS1R0Y2JpQWdJQ0I5SUdWc2MyVWdlMXh1SUNBZ0lDQWdaMlZ1Um5WdUxsOWZjSEp2ZEc5Zlh5QTlJRWRsYm1WeVlYUnZja1oxYm1OMGFXOXVVSEp2ZEc5MGVYQmxPMXh1SUNBZ0lDQWdhV1lnS0NFb2RHOVRkSEpwYm1kVVlXZFRlVzFpYjJ3Z2FXNGdaMlZ1Um5WdUtTa2dlMXh1SUNBZ0lDQWdJQ0JuWlc1R2RXNWJkRzlUZEhKcGJtZFVZV2RUZVcxaWIyeGRJRDBnWENKSFpXNWxjbUYwYjNKR2RXNWpkR2x2Ymx3aU8xeHVJQ0FnSUNBZ2ZWeHVJQ0FnSUgxY2JpQWdJQ0JuWlc1R2RXNHVjSEp2ZEc5MGVYQmxJRDBnVDJKcVpXTjBMbU55WldGMFpTaEhjQ2s3WEc0Z0lDQWdjbVYwZFhKdUlHZGxia1oxYmp0Y2JpQWdmVHRjYmx4dUlDQXZMeUJYYVhSb2FXNGdkR2hsSUdKdlpIa2diMllnWVc1NUlHRnplVzVqSUdaMWJtTjBhVzl1TENCZ1lYZGhhWFFnZUdBZ2FYTWdkSEpoYm5ObWIzSnRaV1FnZEc5Y2JpQWdMeThnWUhscFpXeGtJSEpsWjJWdVpYSmhkRzl5VW5WdWRHbHRaUzVoZDNKaGNDaDRLV0FzSUhOdklIUm9ZWFFnZEdobElISjFiblJwYldVZ1kyRnVJSFJsYzNSY2JpQWdMeThnWUdoaGMwOTNiaTVqWVd4c0tIWmhiSFZsTENCY0lsOWZZWGRoYVhSY0lpbGdJSFJ2SUdSbGRHVnliV2x1WlNCcFppQjBhR1VnZVdsbGJHUmxaQ0IyWVd4MVpTQnBjMXh1SUNBdkx5QnRaV0Z1ZENCMGJ5QmlaU0JoZDJGcGRHVmtMbHh1SUNCbGVIQnZjblJ6TG1GM2NtRndJRDBnWm5WdVkzUnBiMjRvWVhKbktTQjdYRzRnSUNBZ2NtVjBkWEp1SUhzZ1gxOWhkMkZwZERvZ1lYSm5JSDA3WEc0Z0lIMDdYRzVjYmlBZ1puVnVZM1JwYjI0Z1FYTjVibU5KZEdWeVlYUnZjaWhuWlc1bGNtRjBiM0lwSUh0Y2JpQWdJQ0JtZFc1amRHbHZiaUJwYm5admEyVW9iV1YwYUc5a0xDQmhjbWNzSUhKbGMyOXNkbVVzSUhKbGFtVmpkQ2tnZTF4dUlDQWdJQ0FnZG1GeUlISmxZMjl5WkNBOUlIUnllVU5oZEdOb0tHZGxibVZ5WVhSdmNsdHRaWFJvYjJSZExDQm5aVzVsY21GMGIzSXNJR0Z5WnlrN1hHNGdJQ0FnSUNCcFppQW9jbVZqYjNKa0xuUjVjR1VnUFQwOUlGd2lkR2h5YjNkY0lpa2dlMXh1SUNBZ0lDQWdJQ0J5WldwbFkzUW9jbVZqYjNKa0xtRnlaeWs3WEc0Z0lDQWdJQ0I5SUdWc2MyVWdlMXh1SUNBZ0lDQWdJQ0IyWVhJZ2NtVnpkV3gwSUQwZ2NtVmpiM0prTG1GeVp6dGNiaUFnSUNBZ0lDQWdkbUZ5SUhaaGJIVmxJRDBnY21WemRXeDBMblpoYkhWbE8xeHVJQ0FnSUNBZ0lDQnBaaUFvZG1Gc2RXVWdKaVpjYmlBZ0lDQWdJQ0FnSUNBZ0lIUjVjR1Z2WmlCMllXeDFaU0E5UFQwZ1hDSnZZbXBsWTNSY0lpQW1KbHh1SUNBZ0lDQWdJQ0FnSUNBZ2FHRnpUM2R1TG1OaGJHd29kbUZzZFdVc0lGd2lYMTloZDJGcGRGd2lLU2tnZTF4dUlDQWdJQ0FnSUNBZ0lISmxkSFZ5YmlCUWNtOXRhWE5sTG5KbGMyOXNkbVVvZG1Gc2RXVXVYMTloZDJGcGRDa3VkR2hsYmlobWRXNWpkR2x2YmloMllXeDFaU2tnZTF4dUlDQWdJQ0FnSUNBZ0lDQWdhVzUyYjJ0bEtGd2libVY0ZEZ3aUxDQjJZV3gxWlN3Z2NtVnpiMngyWlN3Z2NtVnFaV04wS1R0Y2JpQWdJQ0FnSUNBZ0lDQjlMQ0JtZFc1amRHbHZiaWhsY25JcElIdGNiaUFnSUNBZ0lDQWdJQ0FnSUdsdWRtOXJaU2hjSW5Sb2NtOTNYQ0lzSUdWeWNpd2djbVZ6YjJ4MlpTd2djbVZxWldOMEtUdGNiaUFnSUNBZ0lDQWdJQ0I5S1R0Y2JpQWdJQ0FnSUNBZ2ZWeHVYRzRnSUNBZ0lDQWdJSEpsZEhWeWJpQlFjbTl0YVhObExuSmxjMjlzZG1Vb2RtRnNkV1VwTG5Sb1pXNG9ablZ1WTNScGIyNG9kVzUzY21Gd2NHVmtLU0I3WEc0Z0lDQWdJQ0FnSUNBZ0x5OGdWMmhsYmlCaElIbHBaV3hrWldRZ1VISnZiV2x6WlNCcGN5QnlaWE52YkhabFpDd2dhWFJ6SUdacGJtRnNJSFpoYkhWbElHSmxZMjl0WlhOY2JpQWdJQ0FnSUNBZ0lDQXZMeUIwYUdVZ0xuWmhiSFZsSUc5bUlIUm9aU0JRY205dGFYTmxQSHQyWVd4MVpTeGtiMjVsZlQ0Z2NtVnpkV3gwSUdadmNpQjBhR1ZjYmlBZ0lDQWdJQ0FnSUNBdkx5QmpkWEp5Wlc1MElHbDBaWEpoZEdsdmJpNWNiaUFnSUNBZ0lDQWdJQ0J5WlhOMWJIUXVkbUZzZFdVZ1BTQjFibmR5WVhCd1pXUTdYRzRnSUNBZ0lDQWdJQ0FnY21WemIyeDJaU2h5WlhOMWJIUXBPMXh1SUNBZ0lDQWdJQ0I5TENCbWRXNWpkR2x2YmlobGNuSnZjaWtnZTF4dUlDQWdJQ0FnSUNBZ0lDOHZJRWxtSUdFZ2NtVnFaV04wWldRZ1VISnZiV2x6WlNCM1lYTWdlV2xsYkdSbFpDd2dkR2h5YjNjZ2RHaGxJSEpsYW1WamRHbHZiaUJpWVdOclhHNGdJQ0FnSUNBZ0lDQWdMeThnYVc1MGJ5QjBhR1VnWVhONWJtTWdaMlZ1WlhKaGRHOXlJR1oxYm1OMGFXOXVJSE52SUdsMElHTmhiaUJpWlNCb1lXNWtiR1ZrSUhSb1pYSmxMbHh1SUNBZ0lDQWdJQ0FnSUhKbGRIVnliaUJwYm5admEyVW9YQ0owYUhKdmQxd2lMQ0JsY25KdmNpd2djbVZ6YjJ4MlpTd2djbVZxWldOMEtUdGNiaUFnSUNBZ0lDQWdmU2s3WEc0Z0lDQWdJQ0I5WEc0Z0lDQWdmVnh1WEc0Z0lDQWdkbUZ5SUhCeVpYWnBiM1Z6VUhKdmJXbHpaVHRjYmx4dUlDQWdJR1oxYm1OMGFXOXVJR1Z1Y1hWbGRXVW9iV1YwYUc5a0xDQmhjbWNwSUh0Y2JpQWdJQ0FnSUdaMWJtTjBhVzl1SUdOaGJHeEpiblp2YTJWWGFYUm9UV1YwYUc5a1FXNWtRWEpuS0NrZ2UxeHVJQ0FnSUNBZ0lDQnlaWFIxY200Z2JtVjNJRkJ5YjIxcGMyVW9ablZ1WTNScGIyNG9jbVZ6YjJ4MlpTd2djbVZxWldOMEtTQjdYRzRnSUNBZ0lDQWdJQ0FnYVc1MmIydGxLRzFsZEdodlpDd2dZWEpuTENCeVpYTnZiSFpsTENCeVpXcGxZM1FwTzF4dUlDQWdJQ0FnSUNCOUtUdGNiaUFnSUNBZ0lIMWNibHh1SUNBZ0lDQWdjbVYwZFhKdUlIQnlaWFpwYjNWelVISnZiV2x6WlNBOVhHNGdJQ0FnSUNBZ0lDOHZJRWxtSUdWdWNYVmxkV1VnYUdGeklHSmxaVzRnWTJGc2JHVmtJR0psWm05eVpTd2dkR2hsYmlCM1pTQjNZVzUwSUhSdklIZGhhWFFnZFc1MGFXeGNiaUFnSUNBZ0lDQWdMeThnWVd4c0lIQnlaWFpwYjNWeklGQnliMjFwYzJWeklHaGhkbVVnWW1WbGJpQnlaWE52YkhabFpDQmlaV1p2Y21VZ1kyRnNiR2x1WnlCcGJuWnZhMlVzWEc0Z0lDQWdJQ0FnSUM4dklITnZJSFJvWVhRZ2NtVnpkV3gwY3lCaGNtVWdZV3gzWVhseklHUmxiR2wyWlhKbFpDQnBiaUIwYUdVZ1kyOXljbVZqZENCdmNtUmxjaTRnU1daY2JpQWdJQ0FnSUNBZ0x5OGdaVzV4ZFdWMVpTQm9ZWE1nYm05MElHSmxaVzRnWTJGc2JHVmtJR0psWm05eVpTd2dkR2hsYmlCcGRDQnBjeUJwYlhCdmNuUmhiblFnZEc5Y2JpQWdJQ0FnSUNBZ0x5OGdZMkZzYkNCcGJuWnZhMlVnYVcxdFpXUnBZWFJsYkhrc0lIZHBkR2h2ZFhRZ2QyRnBkR2x1WnlCdmJpQmhJR05oYkd4aVlXTnJJSFJ2SUdacGNtVXNYRzRnSUNBZ0lDQWdJQzh2SUhOdklIUm9ZWFFnZEdobElHRnplVzVqSUdkbGJtVnlZWFJ2Y2lCbWRXNWpkR2x2YmlCb1lYTWdkR2hsSUc5d2NHOXlkSFZ1YVhSNUlIUnZJR1J2WEc0Z0lDQWdJQ0FnSUM4dklHRnVlU0J1WldObGMzTmhjbmtnYzJWMGRYQWdhVzRnWVNCd2NtVmthV04wWVdKc1pTQjNZWGt1SUZSb2FYTWdjSEpsWkdsamRHRmlhV3hwZEhsY2JpQWdJQ0FnSUNBZ0x5OGdhWE1nZDJoNUlIUm9aU0JRY205dGFYTmxJR052Ym5OMGNuVmpkRzl5SUhONWJtTm9jbTl1YjNWemJIa2dhVzUyYjJ0bGN5QnBkSE5jYmlBZ0lDQWdJQ0FnTHk4Z1pYaGxZM1YwYjNJZ1kyRnNiR0poWTJzc0lHRnVaQ0IzYUhrZ1lYTjVibU1nWm5WdVkzUnBiMjV6SUhONWJtTm9jbTl1YjNWemJIbGNiaUFnSUNBZ0lDQWdMeThnWlhobFkzVjBaU0JqYjJSbElHSmxabTl5WlNCMGFHVWdabWx5YzNRZ1lYZGhhWFF1SUZOcGJtTmxJSGRsSUdsdGNHeGxiV1Z1ZENCemFXMXdiR1ZjYmlBZ0lDQWdJQ0FnTHk4Z1lYTjVibU1nWm5WdVkzUnBiMjV6SUdsdUlIUmxjbTF6SUc5bUlHRnplVzVqSUdkbGJtVnlZWFJ2Y25Nc0lHbDBJR2x6SUdWemNHVmphV0ZzYkhsY2JpQWdJQ0FnSUNBZ0x5OGdhVzF3YjNKMFlXNTBJSFJ2SUdkbGRDQjBhR2x6SUhKcFoyaDBMQ0JsZG1WdUlIUm9iM1ZuYUNCcGRDQnlaWEYxYVhKbGN5QmpZWEpsTGx4dUlDQWdJQ0FnSUNCd2NtVjJhVzkxYzFCeWIyMXBjMlVnUHlCd2NtVjJhVzkxYzFCeWIyMXBjMlV1ZEdobGJpaGNiaUFnSUNBZ0lDQWdJQ0JqWVd4c1NXNTJiMnRsVjJsMGFFMWxkR2h2WkVGdVpFRnlaeXhjYmlBZ0lDQWdJQ0FnSUNBdkx5QkJkbTlwWkNCd2NtOXdZV2RoZEdsdVp5Qm1ZV2xzZFhKbGN5QjBieUJRY205dGFYTmxjeUJ5WlhSMWNtNWxaQ0JpZVNCc1lYUmxjbHh1SUNBZ0lDQWdJQ0FnSUM4dklHbHVkbTlqWVhScGIyNXpJRzltSUhSb1pTQnBkR1Z5WVhSdmNpNWNiaUFnSUNBZ0lDQWdJQ0JqWVd4c1NXNTJiMnRsVjJsMGFFMWxkR2h2WkVGdVpFRnlaMXh1SUNBZ0lDQWdJQ0FwSURvZ1kyRnNiRWx1ZG05clpWZHBkR2hOWlhSb2IyUkJibVJCY21jb0tUdGNiaUFnSUNCOVhHNWNiaUFnSUNBdkx5QkVaV1pwYm1VZ2RHaGxJSFZ1YVdacFpXUWdhR1ZzY0dWeUlHMWxkR2h2WkNCMGFHRjBJR2x6SUhWelpXUWdkRzhnYVcxd2JHVnRaVzUwSUM1dVpYaDBMRnh1SUNBZ0lDOHZJQzUwYUhKdmR5d2dZVzVrSUM1eVpYUjFjbTRnS0hObFpTQmtaV1pwYm1WSmRHVnlZWFJ2Y2sxbGRHaHZaSE1wTGx4dUlDQWdJSFJvYVhNdVgybHVkbTlyWlNBOUlHVnVjWFZsZFdVN1hHNGdJSDFjYmx4dUlDQmtaV1pwYm1WSmRHVnlZWFJ2Y2sxbGRHaHZaSE1vUVhONWJtTkpkR1Z5WVhSdmNpNXdjbTkwYjNSNWNHVXBPMXh1SUNCQmMzbHVZMGwwWlhKaGRHOXlMbkJ5YjNSdmRIbHdaVnRoYzNsdVkwbDBaWEpoZEc5eVUzbHRZbTlzWFNBOUlHWjFibU4wYVc5dUlDZ3BJSHRjYmlBZ0lDQnlaWFIxY200Z2RHaHBjenRjYmlBZ2ZUdGNiaUFnWlhod2IzSjBjeTVCYzNsdVkwbDBaWEpoZEc5eUlEMGdRWE41Ym1OSmRHVnlZWFJ2Y2p0Y2JseHVJQ0F2THlCT2IzUmxJSFJvWVhRZ2MybHRjR3hsSUdGemVXNWpJR1oxYm1OMGFXOXVjeUJoY21VZ2FXMXdiR1Z0Wlc1MFpXUWdiMjRnZEc5d0lHOW1YRzRnSUM4dklFRnplVzVqU1hSbGNtRjBiM0lnYjJKcVpXTjBjenNnZEdobGVTQnFkWE4wSUhKbGRIVnliaUJoSUZCeWIyMXBjMlVnWm05eUlIUm9aU0IyWVd4MVpTQnZabHh1SUNBdkx5QjBhR1VnWm1sdVlXd2djbVZ6ZFd4MElIQnliMlIxWTJWa0lHSjVJSFJvWlNCcGRHVnlZWFJ2Y2k1Y2JpQWdaWGh3YjNKMGN5NWhjM2x1WXlBOUlHWjFibU4wYVc5dUtHbHVibVZ5Um00c0lHOTFkR1Z5Um00c0lITmxiR1lzSUhSeWVVeHZZM05NYVhOMEtTQjdYRzRnSUNBZ2RtRnlJR2wwWlhJZ1BTQnVaWGNnUVhONWJtTkpkR1Z5WVhSdmNpaGNiaUFnSUNBZ0lIZHlZWEFvYVc1dVpYSkdiaXdnYjNWMFpYSkdiaXdnYzJWc1ppd2dkSEo1VEc5amMweHBjM1FwWEc0Z0lDQWdLVHRjYmx4dUlDQWdJSEpsZEhWeWJpQmxlSEJ2Y25SekxtbHpSMlZ1WlhKaGRHOXlSblZ1WTNScGIyNG9iM1YwWlhKR2JpbGNiaUFnSUNBZ0lEOGdhWFJsY2lBdkx5QkpaaUJ2ZFhSbGNrWnVJR2x6SUdFZ1oyVnVaWEpoZEc5eUxDQnlaWFIxY200Z2RHaGxJR1oxYkd3Z2FYUmxjbUYwYjNJdVhHNGdJQ0FnSUNBNklHbDBaWEl1Ym1WNGRDZ3BMblJvWlc0b1puVnVZM1JwYjI0b2NtVnpkV3gwS1NCN1hHNGdJQ0FnSUNBZ0lDQWdjbVYwZFhKdUlISmxjM1ZzZEM1a2IyNWxJRDhnY21WemRXeDBMblpoYkhWbElEb2dhWFJsY2k1dVpYaDBLQ2s3WEc0Z0lDQWdJQ0FnSUgwcE8xeHVJQ0I5TzF4dVhHNGdJR1oxYm1OMGFXOXVJRzFoYTJWSmJuWnZhMlZOWlhSb2IyUW9hVzV1WlhKR2Jpd2djMlZzWml3Z1kyOXVkR1Y0ZENrZ2UxeHVJQ0FnSUhaaGNpQnpkR0YwWlNBOUlFZGxibE4wWVhSbFUzVnpjR1Z1WkdWa1UzUmhjblE3WEc1Y2JpQWdJQ0J5WlhSMWNtNGdablZ1WTNScGIyNGdhVzUyYjJ0bEtHMWxkR2h2WkN3Z1lYSm5LU0I3WEc0Z0lDQWdJQ0JwWmlBb2MzUmhkR1VnUFQwOUlFZGxibE4wWVhSbFJYaGxZM1YwYVc1bktTQjdYRzRnSUNBZ0lDQWdJSFJvY205M0lHNWxkeUJGY25KdmNpaGNJa2RsYm1WeVlYUnZjaUJwY3lCaGJISmxZV1I1SUhKMWJtNXBibWRjSWlrN1hHNGdJQ0FnSUNCOVhHNWNiaUFnSUNBZ0lHbG1JQ2h6ZEdGMFpTQTlQVDBnUjJWdVUzUmhkR1ZEYjIxd2JHVjBaV1FwSUh0Y2JpQWdJQ0FnSUNBZ2FXWWdLRzFsZEdodlpDQTlQVDBnWENKMGFISnZkMXdpS1NCN1hHNGdJQ0FnSUNBZ0lDQWdkR2h5YjNjZ1lYSm5PMXh1SUNBZ0lDQWdJQ0I5WEc1Y2JpQWdJQ0FnSUNBZ0x5OGdRbVVnWm05eVoybDJhVzVuTENCd1pYSWdNalV1TXk0ekxqTXVNeUJ2WmlCMGFHVWdjM0JsWXpwY2JpQWdJQ0FnSUNBZ0x5OGdhSFIwY0hNNkx5OXdaVzl3YkdVdWJXOTZhV3hzWVM1dmNtY3ZmbXB2Y21WdVpHOXlabVl2WlhNMkxXUnlZV1owTG1oMGJXd2pjMlZqTFdkbGJtVnlZWFJ2Y25KbGMzVnRaVnh1SUNBZ0lDQWdJQ0J5WlhSMWNtNGdaRzl1WlZKbGMzVnNkQ2dwTzF4dUlDQWdJQ0FnZlZ4dVhHNGdJQ0FnSUNCamIyNTBaWGgwTG0xbGRHaHZaQ0E5SUcxbGRHaHZaRHRjYmlBZ0lDQWdJR052Ym5SbGVIUXVZWEpuSUQwZ1lYSm5PMXh1WEc0Z0lDQWdJQ0IzYUdsc1pTQW9kSEoxWlNrZ2UxeHVJQ0FnSUNBZ0lDQjJZWElnWkdWc1pXZGhkR1VnUFNCamIyNTBaWGgwTG1SbGJHVm5ZWFJsTzF4dUlDQWdJQ0FnSUNCcFppQW9aR1ZzWldkaGRHVXBJSHRjYmlBZ0lDQWdJQ0FnSUNCMllYSWdaR1ZzWldkaGRHVlNaWE4xYkhRZ1BTQnRZWGxpWlVsdWRtOXJaVVJsYkdWbllYUmxLR1JsYkdWbllYUmxMQ0JqYjI1MFpYaDBLVHRjYmlBZ0lDQWdJQ0FnSUNCcFppQW9aR1ZzWldkaGRHVlNaWE4xYkhRcElIdGNiaUFnSUNBZ0lDQWdJQ0FnSUdsbUlDaGtaV3hsWjJGMFpWSmxjM1ZzZENBOVBUMGdRMjl1ZEdsdWRXVlRaVzUwYVc1bGJDa2dZMjl1ZEdsdWRXVTdYRzRnSUNBZ0lDQWdJQ0FnSUNCeVpYUjFjbTRnWkdWc1pXZGhkR1ZTWlhOMWJIUTdYRzRnSUNBZ0lDQWdJQ0FnZlZ4dUlDQWdJQ0FnSUNCOVhHNWNiaUFnSUNBZ0lDQWdhV1lnS0dOdmJuUmxlSFF1YldWMGFHOWtJRDA5UFNCY0ltNWxlSFJjSWlrZ2UxeHVJQ0FnSUNBZ0lDQWdJQzh2SUZObGRIUnBibWNnWTI5dWRHVjRkQzVmYzJWdWRDQm1iM0lnYkdWbllXTjVJSE4xY0hCdmNuUWdiMllnUW1GaVpXd25jMXh1SUNBZ0lDQWdJQ0FnSUM4dklHWjFibU4wYVc5dUxuTmxiblFnYVcxd2JHVnRaVzUwWVhScGIyNHVYRzRnSUNBZ0lDQWdJQ0FnWTI5dWRHVjRkQzV6Wlc1MElEMGdZMjl1ZEdWNGRDNWZjMlZ1ZENBOUlHTnZiblJsZUhRdVlYSm5PMXh1WEc0Z0lDQWdJQ0FnSUgwZ1pXeHpaU0JwWmlBb1kyOXVkR1Y0ZEM1dFpYUm9iMlFnUFQwOUlGd2lkR2h5YjNkY0lpa2dlMXh1SUNBZ0lDQWdJQ0FnSUdsbUlDaHpkR0YwWlNBOVBUMGdSMlZ1VTNSaGRHVlRkWE53Wlc1a1pXUlRkR0Z5ZENrZ2UxeHVJQ0FnSUNBZ0lDQWdJQ0FnYzNSaGRHVWdQU0JIWlc1VGRHRjBaVU52YlhCc1pYUmxaRHRjYmlBZ0lDQWdJQ0FnSUNBZ0lIUm9jbTkzSUdOdmJuUmxlSFF1WVhKbk8xeHVJQ0FnSUNBZ0lDQWdJSDFjYmx4dUlDQWdJQ0FnSUNBZ0lHTnZiblJsZUhRdVpHbHpjR0YwWTJoRmVHTmxjSFJwYjI0b1kyOXVkR1Y0ZEM1aGNtY3BPMXh1WEc0Z0lDQWdJQ0FnSUgwZ1pXeHpaU0JwWmlBb1kyOXVkR1Y0ZEM1dFpYUm9iMlFnUFQwOUlGd2ljbVYwZFhKdVhDSXBJSHRjYmlBZ0lDQWdJQ0FnSUNCamIyNTBaWGgwTG1GaWNuVndkQ2hjSW5KbGRIVnlibHdpTENCamIyNTBaWGgwTG1GeVp5azdYRzRnSUNBZ0lDQWdJSDFjYmx4dUlDQWdJQ0FnSUNCemRHRjBaU0E5SUVkbGJsTjBZWFJsUlhobFkzVjBhVzVuTzF4dVhHNGdJQ0FnSUNBZ0lIWmhjaUJ5WldOdmNtUWdQU0IwY25sRFlYUmphQ2hwYm01bGNrWnVMQ0J6Wld4bUxDQmpiMjUwWlhoMEtUdGNiaUFnSUNBZ0lDQWdhV1lnS0hKbFkyOXlaQzUwZVhCbElEMDlQU0JjSW01dmNtMWhiRndpS1NCN1hHNGdJQ0FnSUNBZ0lDQWdMeThnU1dZZ1lXNGdaWGhqWlhCMGFXOXVJR2x6SUhSb2NtOTNiaUJtY205dElHbHVibVZ5Um00c0lIZGxJR3hsWVhabElITjBZWFJsSUQwOVBWeHVJQ0FnSUNBZ0lDQWdJQzh2SUVkbGJsTjBZWFJsUlhobFkzVjBhVzVuSUdGdVpDQnNiMjl3SUdKaFkyc2dabTl5SUdGdWIzUm9aWElnYVc1MmIyTmhkR2x2Ymk1Y2JpQWdJQ0FnSUNBZ0lDQnpkR0YwWlNBOUlHTnZiblJsZUhRdVpHOXVaVnh1SUNBZ0lDQWdJQ0FnSUNBZ1B5QkhaVzVUZEdGMFpVTnZiWEJzWlhSbFpGeHVJQ0FnSUNBZ0lDQWdJQ0FnT2lCSFpXNVRkR0YwWlZOMWMzQmxibVJsWkZscFpXeGtPMXh1WEc0Z0lDQWdJQ0FnSUNBZ2FXWWdLSEpsWTI5eVpDNWhjbWNnUFQwOUlFTnZiblJwYm5WbFUyVnVkR2x1Wld3cElIdGNiaUFnSUNBZ0lDQWdJQ0FnSUdOdmJuUnBiblZsTzF4dUlDQWdJQ0FnSUNBZ0lIMWNibHh1SUNBZ0lDQWdJQ0FnSUhKbGRIVnliaUI3WEc0Z0lDQWdJQ0FnSUNBZ0lDQjJZV3gxWlRvZ2NtVmpiM0prTG1GeVp5eGNiaUFnSUNBZ0lDQWdJQ0FnSUdSdmJtVTZJR052Ym5SbGVIUXVaRzl1WlZ4dUlDQWdJQ0FnSUNBZ0lIMDdYRzVjYmlBZ0lDQWdJQ0FnZlNCbGJITmxJR2xtSUNoeVpXTnZjbVF1ZEhsd1pTQTlQVDBnWENKMGFISnZkMXdpS1NCN1hHNGdJQ0FnSUNBZ0lDQWdjM1JoZEdVZ1BTQkhaVzVUZEdGMFpVTnZiWEJzWlhSbFpEdGNiaUFnSUNBZ0lDQWdJQ0F2THlCRWFYTndZWFJqYUNCMGFHVWdaWGhqWlhCMGFXOXVJR0o1SUd4dmIzQnBibWNnWW1GamF5QmhjbTkxYm1RZ2RHOGdkR2hsWEc0Z0lDQWdJQ0FnSUNBZ0x5OGdZMjl1ZEdWNGRDNWthWE53WVhSamFFVjRZMlZ3ZEdsdmJpaGpiMjUwWlhoMExtRnlaeWtnWTJGc2JDQmhZbTkyWlM1Y2JpQWdJQ0FnSUNBZ0lDQmpiMjUwWlhoMExtMWxkR2h2WkNBOUlGd2lkR2h5YjNkY0lqdGNiaUFnSUNBZ0lDQWdJQ0JqYjI1MFpYaDBMbUZ5WnlBOUlISmxZMjl5WkM1aGNtYzdYRzRnSUNBZ0lDQWdJSDFjYmlBZ0lDQWdJSDFjYmlBZ0lDQjlPMXh1SUNCOVhHNWNiaUFnTHk4Z1EyRnNiQ0JrWld4bFoyRjBaUzVwZEdWeVlYUnZjbHRqYjI1MFpYaDBMbTFsZEdodlpGMG9ZMjl1ZEdWNGRDNWhjbWNwSUdGdVpDQm9ZVzVrYkdVZ2RHaGxYRzRnSUM4dklISmxjM1ZzZEN3Z1pXbDBhR1Z5SUdKNUlISmxkSFZ5Ym1sdVp5QmhJSHNnZG1Gc2RXVXNJR1J2Ym1VZ2ZTQnlaWE4xYkhRZ1puSnZiU0IwYUdWY2JpQWdMeThnWkdWc1pXZGhkR1VnYVhSbGNtRjBiM0lzSUc5eUlHSjVJRzF2WkdsbWVXbHVaeUJqYjI1MFpYaDBMbTFsZEdodlpDQmhibVFnWTI5dWRHVjRkQzVoY21jc1hHNGdJQzh2SUhObGRIUnBibWNnWTI5dWRHVjRkQzVrWld4bFoyRjBaU0IwYnlCdWRXeHNMQ0JoYm1RZ2NtVjBkWEp1YVc1bklIUm9aU0JEYjI1MGFXNTFaVk5sYm5ScGJtVnNMbHh1SUNCbWRXNWpkR2x2YmlCdFlYbGlaVWx1ZG05clpVUmxiR1ZuWVhSbEtHUmxiR1ZuWVhSbExDQmpiMjUwWlhoMEtTQjdYRzRnSUNBZ2RtRnlJRzFsZEdodlpDQTlJR1JsYkdWbllYUmxMbWwwWlhKaGRHOXlXMk52Ym5SbGVIUXViV1YwYUc5a1hUdGNiaUFnSUNCcFppQW9iV1YwYUc5a0lEMDlQU0IxYm1SbFptbHVaV1FwSUh0Y2JpQWdJQ0FnSUM4dklFRWdMblJvY205M0lHOXlJQzV5WlhSMWNtNGdkMmhsYmlCMGFHVWdaR1ZzWldkaGRHVWdhWFJsY21GMGIzSWdhR0Z6SUc1dklDNTBhSEp2ZDF4dUlDQWdJQ0FnTHk4Z2JXVjBhRzlrSUdGc2QyRjVjeUIwWlhKdGFXNWhkR1Z6SUhSb1pTQjVhV1ZzWkNvZ2JHOXZjQzVjYmlBZ0lDQWdJR052Ym5SbGVIUXVaR1ZzWldkaGRHVWdQU0J1ZFd4c08xeHVYRzRnSUNBZ0lDQnBaaUFvWTI5dWRHVjRkQzV0WlhSb2IyUWdQVDA5SUZ3aWRHaHliM2RjSWlrZ2UxeHVJQ0FnSUNBZ0lDQXZMeUJPYjNSbE9pQmJYQ0p5WlhSMWNtNWNJbDBnYlhWemRDQmlaU0IxYzJWa0lHWnZjaUJGVXpNZ2NHRnljMmx1WnlCamIyMXdZWFJwWW1sc2FYUjVMbHh1SUNBZ0lDQWdJQ0JwWmlBb1pHVnNaV2RoZEdVdWFYUmxjbUYwYjNKYlhDSnlaWFIxY201Y0lsMHBJSHRjYmlBZ0lDQWdJQ0FnSUNBdkx5QkpaaUIwYUdVZ1pHVnNaV2RoZEdVZ2FYUmxjbUYwYjNJZ2FHRnpJR0VnY21WMGRYSnVJRzFsZEdodlpDd2daMmwyWlNCcGRDQmhYRzRnSUNBZ0lDQWdJQ0FnTHk4Z1kyaGhibU5sSUhSdklHTnNaV0Z1SUhWd0xseHVJQ0FnSUNBZ0lDQWdJR052Ym5SbGVIUXViV1YwYUc5a0lEMGdYQ0p5WlhSMWNtNWNJanRjYmlBZ0lDQWdJQ0FnSUNCamIyNTBaWGgwTG1GeVp5QTlJSFZ1WkdWbWFXNWxaRHRjYmlBZ0lDQWdJQ0FnSUNCdFlYbGlaVWx1ZG05clpVUmxiR1ZuWVhSbEtHUmxiR1ZuWVhSbExDQmpiMjUwWlhoMEtUdGNibHh1SUNBZ0lDQWdJQ0FnSUdsbUlDaGpiMjUwWlhoMExtMWxkR2h2WkNBOVBUMGdYQ0owYUhKdmQxd2lLU0I3WEc0Z0lDQWdJQ0FnSUNBZ0lDQXZMeUJKWmlCdFlYbGlaVWx1ZG05clpVUmxiR1ZuWVhSbEtHTnZiblJsZUhRcElHTm9ZVzVuWldRZ1kyOXVkR1Y0ZEM1dFpYUm9iMlFnWm5KdmJWeHVJQ0FnSUNBZ0lDQWdJQ0FnTHk4Z1hDSnlaWFIxY201Y0lpQjBieUJjSW5Sb2NtOTNYQ0lzSUd4bGRDQjBhR0YwSUc5MlpYSnlhV1JsSUhSb1pTQlVlWEJsUlhKeWIzSWdZbVZzYjNjdVhHNGdJQ0FnSUNBZ0lDQWdJQ0J5WlhSMWNtNGdRMjl1ZEdsdWRXVlRaVzUwYVc1bGJEdGNiaUFnSUNBZ0lDQWdJQ0I5WEc0Z0lDQWdJQ0FnSUgxY2JseHVJQ0FnSUNBZ0lDQmpiMjUwWlhoMExtMWxkR2h2WkNBOUlGd2lkR2h5YjNkY0lqdGNiaUFnSUNBZ0lDQWdZMjl1ZEdWNGRDNWhjbWNnUFNCdVpYY2dWSGx3WlVWeWNtOXlLRnh1SUNBZ0lDQWdJQ0FnSUZ3aVZHaGxJR2wwWlhKaGRHOXlJR1J2WlhNZ2JtOTBJSEJ5YjNacFpHVWdZU0FuZEdoeWIzY25JRzFsZEdodlpGd2lLVHRjYmlBZ0lDQWdJSDFjYmx4dUlDQWdJQ0FnY21WMGRYSnVJRU52Ym5ScGJuVmxVMlZ1ZEdsdVpXdzdYRzRnSUNBZ2ZWeHVYRzRnSUNBZ2RtRnlJSEpsWTI5eVpDQTlJSFJ5ZVVOaGRHTm9LRzFsZEdodlpDd2daR1ZzWldkaGRHVXVhWFJsY21GMGIzSXNJR052Ym5SbGVIUXVZWEpuS1R0Y2JseHVJQ0FnSUdsbUlDaHlaV052Y21RdWRIbHdaU0E5UFQwZ1hDSjBhSEp2ZDF3aUtTQjdYRzRnSUNBZ0lDQmpiMjUwWlhoMExtMWxkR2h2WkNBOUlGd2lkR2h5YjNkY0lqdGNiaUFnSUNBZ0lHTnZiblJsZUhRdVlYSm5JRDBnY21WamIzSmtMbUZ5Wnp0Y2JpQWdJQ0FnSUdOdmJuUmxlSFF1WkdWc1pXZGhkR1VnUFNCdWRXeHNPMXh1SUNBZ0lDQWdjbVYwZFhKdUlFTnZiblJwYm5WbFUyVnVkR2x1Wld3N1hHNGdJQ0FnZlZ4dVhHNGdJQ0FnZG1GeUlHbHVabThnUFNCeVpXTnZjbVF1WVhKbk8xeHVYRzRnSUNBZ2FXWWdLQ0VnYVc1bWJ5a2dlMXh1SUNBZ0lDQWdZMjl1ZEdWNGRDNXRaWFJvYjJRZ1BTQmNJblJvY205M1hDSTdYRzRnSUNBZ0lDQmpiMjUwWlhoMExtRnlaeUE5SUc1bGR5QlVlWEJsUlhKeWIzSW9YQ0pwZEdWeVlYUnZjaUJ5WlhOMWJIUWdhWE1nYm05MElHRnVJRzlpYW1WamRGd2lLVHRjYmlBZ0lDQWdJR052Ym5SbGVIUXVaR1ZzWldkaGRHVWdQU0J1ZFd4c08xeHVJQ0FnSUNBZ2NtVjBkWEp1SUVOdmJuUnBiblZsVTJWdWRHbHVaV3c3WEc0Z0lDQWdmVnh1WEc0Z0lDQWdhV1lnS0dsdVptOHVaRzl1WlNrZ2UxeHVJQ0FnSUNBZ0x5OGdRWE56YVdkdUlIUm9aU0J5WlhOMWJIUWdiMllnZEdobElHWnBibWx6YUdWa0lHUmxiR1ZuWVhSbElIUnZJSFJvWlNCMFpXMXdiM0poY25sY2JpQWdJQ0FnSUM4dklIWmhjbWxoWW14bElITndaV05wWm1sbFpDQmllU0JrWld4bFoyRjBaUzV5WlhOMWJIUk9ZVzFsSUNoelpXVWdaR1ZzWldkaGRHVlphV1ZzWkNrdVhHNGdJQ0FnSUNCamIyNTBaWGgwVzJSbGJHVm5ZWFJsTG5KbGMzVnNkRTVoYldWZElEMGdhVzVtYnk1MllXeDFaVHRjYmx4dUlDQWdJQ0FnTHk4Z1VtVnpkVzFsSUdWNFpXTjFkR2x2YmlCaGRDQjBhR1VnWkdWemFYSmxaQ0JzYjJOaGRHbHZiaUFvYzJWbElHUmxiR1ZuWVhSbFdXbGxiR1FwTGx4dUlDQWdJQ0FnWTI5dWRHVjRkQzV1WlhoMElEMGdaR1ZzWldkaGRHVXVibVY0ZEV4dll6dGNibHh1SUNBZ0lDQWdMeThnU1dZZ1kyOXVkR1Y0ZEM1dFpYUm9iMlFnZDJGeklGd2lkR2h5YjNkY0lpQmlkWFFnZEdobElHUmxiR1ZuWVhSbElHaGhibVJzWldRZ2RHaGxYRzRnSUNBZ0lDQXZMeUJsZUdObGNIUnBiMjRzSUd4bGRDQjBhR1VnYjNWMFpYSWdaMlZ1WlhKaGRHOXlJSEJ5YjJObFpXUWdibTl5YldGc2JIa3VJRWxtWEc0Z0lDQWdJQ0F2THlCamIyNTBaWGgwTG0xbGRHaHZaQ0IzWVhNZ1hDSnVaWGgwWENJc0lHWnZjbWRsZENCamIyNTBaWGgwTG1GeVp5QnphVzVqWlNCcGRDQm9ZWE1nWW1WbGJseHVJQ0FnSUNBZ0x5OGdYQ0pqYjI1emRXMWxaRndpSUdKNUlIUm9aU0JrWld4bFoyRjBaU0JwZEdWeVlYUnZjaTRnU1dZZ1kyOXVkR1Y0ZEM1dFpYUm9iMlFnZDJGelhHNGdJQ0FnSUNBdkx5QmNJbkpsZEhWeWJsd2lMQ0JoYkd4dmR5QjBhR1VnYjNKcFoybHVZV3dnTG5KbGRIVnliaUJqWVd4c0lIUnZJR052Ym5ScGJuVmxJR2x1SUhSb1pWeHVJQ0FnSUNBZ0x5OGdiM1YwWlhJZ1oyVnVaWEpoZEc5eUxseHVJQ0FnSUNBZ2FXWWdLR052Ym5SbGVIUXViV1YwYUc5a0lDRTlQU0JjSW5KbGRIVnlibHdpS1NCN1hHNGdJQ0FnSUNBZ0lHTnZiblJsZUhRdWJXVjBhRzlrSUQwZ1hDSnVaWGgwWENJN1hHNGdJQ0FnSUNBZ0lHTnZiblJsZUhRdVlYSm5JRDBnZFc1a1pXWnBibVZrTzF4dUlDQWdJQ0FnZlZ4dVhHNGdJQ0FnZlNCbGJITmxJSHRjYmlBZ0lDQWdJQzh2SUZKbExYbHBaV3hrSUhSb1pTQnlaWE4xYkhRZ2NtVjBkWEp1WldRZ1lua2dkR2hsSUdSbGJHVm5ZWFJsSUcxbGRHaHZaQzVjYmlBZ0lDQWdJSEpsZEhWeWJpQnBibVp2TzF4dUlDQWdJSDFjYmx4dUlDQWdJQzh2SUZSb1pTQmtaV3hsWjJGMFpTQnBkR1Z5WVhSdmNpQnBjeUJtYVc1cGMyaGxaQ3dnYzI4Z1ptOXlaMlYwSUdsMElHRnVaQ0JqYjI1MGFXNTFaU0IzYVhSb1hHNGdJQ0FnTHk4Z2RHaGxJRzkxZEdWeUlHZGxibVZ5WVhSdmNpNWNiaUFnSUNCamIyNTBaWGgwTG1SbGJHVm5ZWFJsSUQwZ2JuVnNiRHRjYmlBZ0lDQnlaWFIxY200Z1EyOXVkR2x1ZFdWVFpXNTBhVzVsYkR0Y2JpQWdmVnh1WEc0Z0lDOHZJRVJsWm1sdVpTQkhaVzVsY21GMGIzSXVjSEp2ZEc5MGVYQmxMbnR1WlhoMExIUm9jbTkzTEhKbGRIVnlibjBnYVc0Z2RHVnliWE1nYjJZZ2RHaGxYRzRnSUM4dklIVnVhV1pwWldRZ0xsOXBiblp2YTJVZ2FHVnNjR1Z5SUcxbGRHaHZaQzVjYmlBZ1pHVm1hVzVsU1hSbGNtRjBiM0pOWlhSb2IyUnpLRWR3S1R0Y2JseHVJQ0JIY0Z0MGIxTjBjbWx1WjFSaFoxTjViV0p2YkYwZ1BTQmNJa2RsYm1WeVlYUnZjbHdpTzF4dVhHNGdJQzh2SUVFZ1IyVnVaWEpoZEc5eUlITm9iM1ZzWkNCaGJIZGhlWE1nY21WMGRYSnVJR2wwYzJWc1ppQmhjeUIwYUdVZ2FYUmxjbUYwYjNJZ2IySnFaV04wSUhkb1pXNGdkR2hsWEc0Z0lDOHZJRUJBYVhSbGNtRjBiM0lnWm5WdVkzUnBiMjRnYVhNZ1kyRnNiR1ZrSUc5dUlHbDBMaUJUYjIxbElHSnliM2R6WlhKekp5QnBiWEJzWlcxbGJuUmhkR2x2Ym5NZ2IyWWdkR2hsWEc0Z0lDOHZJR2wwWlhKaGRHOXlJSEJ5YjNSdmRIbHdaU0JqYUdGcGJpQnBibU52Y25KbFkzUnNlU0JwYlhCc1pXMWxiblFnZEdocGN5d2dZMkYxYzJsdVp5QjBhR1VnUjJWdVpYSmhkRzl5WEc0Z0lDOHZJRzlpYW1WamRDQjBieUJ1YjNRZ1ltVWdjbVYwZFhKdVpXUWdabkp2YlNCMGFHbHpJR05oYkd3dUlGUm9hWE1nWlc1emRYSmxjeUIwYUdGMElHUnZaWE51SjNRZ2FHRndjR1Z1TGx4dUlDQXZMeUJUWldVZ2FIUjBjSE02THk5bmFYUm9kV0l1WTI5dEwyWmhZMlZpYjI5ckwzSmxaMlZ1WlhKaGRHOXlMMmx6YzNWbGN5OHlOelFnWm05eUlHMXZjbVVnWkdWMFlXbHNjeTVjYmlBZ1IzQmJhWFJsY21GMGIzSlRlVzFpYjJ4ZElEMGdablZ1WTNScGIyNG9LU0I3WEc0Z0lDQWdjbVYwZFhKdUlIUm9hWE03WEc0Z0lIMDdYRzVjYmlBZ1IzQXVkRzlUZEhKcGJtY2dQU0JtZFc1amRHbHZiaWdwSUh0Y2JpQWdJQ0J5WlhSMWNtNGdYQ0piYjJKcVpXTjBJRWRsYm1WeVlYUnZjbDFjSWp0Y2JpQWdmVHRjYmx4dUlDQm1kVzVqZEdsdmJpQndkWE5vVkhKNVJXNTBjbmtvYkc5amN5a2dlMXh1SUNBZ0lIWmhjaUJsYm5SeWVTQTlJSHNnZEhKNVRHOWpPaUJzYjJOeld6QmRJSDA3WEc1Y2JpQWdJQ0JwWmlBb01TQnBiaUJzYjJOektTQjdYRzRnSUNBZ0lDQmxiblJ5ZVM1allYUmphRXh2WXlBOUlHeHZZM05iTVYwN1hHNGdJQ0FnZlZ4dVhHNGdJQ0FnYVdZZ0tESWdhVzRnYkc5amN5a2dlMXh1SUNBZ0lDQWdaVzUwY25rdVptbHVZV3hzZVV4dll5QTlJR3h2WTNOYk1sMDdYRzRnSUNBZ0lDQmxiblJ5ZVM1aFpuUmxja3h2WXlBOUlHeHZZM05iTTEwN1hHNGdJQ0FnZlZ4dVhHNGdJQ0FnZEdocGN5NTBjbmxGYm5SeWFXVnpMbkIxYzJnb1pXNTBjbmtwTzF4dUlDQjlYRzVjYmlBZ1puVnVZM1JwYjI0Z2NtVnpaWFJVY25sRmJuUnllU2hsYm5SeWVTa2dlMXh1SUNBZ0lIWmhjaUJ5WldOdmNtUWdQU0JsYm5SeWVTNWpiMjF3YkdWMGFXOXVJSHg4SUh0OU8xeHVJQ0FnSUhKbFkyOXlaQzUwZVhCbElEMGdYQ0p1YjNKdFlXeGNJanRjYmlBZ0lDQmtaV3hsZEdVZ2NtVmpiM0prTG1GeVp6dGNiaUFnSUNCbGJuUnllUzVqYjIxd2JHVjBhVzl1SUQwZ2NtVmpiM0prTzF4dUlDQjlYRzVjYmlBZ1puVnVZM1JwYjI0Z1EyOXVkR1Y0ZENoMGNubE1iMk56VEdsemRDa2dlMXh1SUNBZ0lDOHZJRlJvWlNCeWIyOTBJR1Z1ZEhKNUlHOWlhbVZqZENBb1pXWm1aV04wYVhabGJIa2dZU0IwY25rZ2MzUmhkR1Z0Wlc1MElIZHBkR2h2ZFhRZ1lTQmpZWFJqYUZ4dUlDQWdJQzh2SUc5eUlHRWdabWx1WVd4c2VTQmliRzlqYXlrZ1oybDJaWE1nZFhNZ1lTQndiR0ZqWlNCMGJ5QnpkRzl5WlNCMllXeDFaWE1nZEdoeWIzZHVJR1p5YjIxY2JpQWdJQ0F2THlCc2IyTmhkR2x2Ym5NZ2QyaGxjbVVnZEdobGNtVWdhWE1nYm04Z1pXNWpiRzl6YVc1bklIUnllU0J6ZEdGMFpXMWxiblF1WEc0Z0lDQWdkR2hwY3k1MGNubEZiblJ5YVdWeklEMGdXM3NnZEhKNVRHOWpPaUJjSW5KdmIzUmNJaUI5WFR0Y2JpQWdJQ0IwY25sTWIyTnpUR2x6ZEM1bWIzSkZZV05vS0hCMWMyaFVjbmxGYm5SeWVTd2dkR2hwY3lrN1hHNGdJQ0FnZEdocGN5NXlaWE5sZENoMGNuVmxLVHRjYmlBZ2ZWeHVYRzRnSUdWNGNHOXlkSE11YTJWNWN5QTlJR1oxYm1OMGFXOXVLRzlpYW1WamRDa2dlMXh1SUNBZ0lIWmhjaUJyWlhseklEMGdXMTA3WEc0Z0lDQWdabTl5SUNoMllYSWdhMlY1SUdsdUlHOWlhbVZqZENrZ2UxeHVJQ0FnSUNBZ2EyVjVjeTV3ZFhOb0tHdGxlU2s3WEc0Z0lDQWdmVnh1SUNBZ0lHdGxlWE11Y21WMlpYSnpaU2dwTzF4dVhHNGdJQ0FnTHk4Z1VtRjBhR1Z5SUhSb1lXNGdjbVYwZFhKdWFXNW5JR0Z1SUc5aWFtVmpkQ0IzYVhSb0lHRWdibVY0ZENCdFpYUm9iMlFzSUhkbElHdGxaWEJjYmlBZ0lDQXZMeUIwYUdsdVozTWdjMmx0Y0d4bElHRnVaQ0J5WlhSMWNtNGdkR2hsSUc1bGVIUWdablZ1WTNScGIyNGdhWFJ6Wld4bUxseHVJQ0FnSUhKbGRIVnliaUJtZFc1amRHbHZiaUJ1WlhoMEtDa2dlMXh1SUNBZ0lDQWdkMmhwYkdVZ0tHdGxlWE11YkdWdVozUm9LU0I3WEc0Z0lDQWdJQ0FnSUhaaGNpQnJaWGtnUFNCclpYbHpMbkJ2Y0NncE8xeHVJQ0FnSUNBZ0lDQnBaaUFvYTJWNUlHbHVJRzlpYW1WamRDa2dlMXh1SUNBZ0lDQWdJQ0FnSUc1bGVIUXVkbUZzZFdVZ1BTQnJaWGs3WEc0Z0lDQWdJQ0FnSUNBZ2JtVjRkQzVrYjI1bElEMGdabUZzYzJVN1hHNGdJQ0FnSUNBZ0lDQWdjbVYwZFhKdUlHNWxlSFE3WEc0Z0lDQWdJQ0FnSUgxY2JpQWdJQ0FnSUgxY2JseHVJQ0FnSUNBZ0x5OGdWRzhnWVhadmFXUWdZM0psWVhScGJtY2dZVzRnWVdSa2FYUnBiMjVoYkNCdlltcGxZM1FzSUhkbElHcDFjM1FnYUdGdVp5QjBhR1VnTG5aaGJIVmxYRzRnSUNBZ0lDQXZMeUJoYm1RZ0xtUnZibVVnY0hKdmNHVnlkR2xsY3lCdlptWWdkR2hsSUc1bGVIUWdablZ1WTNScGIyNGdiMkpxWldOMElHbDBjMlZzWmk0Z1ZHaHBjMXh1SUNBZ0lDQWdMeThnWVd4emJ5Qmxibk4xY21WeklIUm9ZWFFnZEdobElHMXBibWxtYVdWeUlIZHBiR3dnYm05MElHRnViMjU1YldsNlpTQjBhR1VnWm5WdVkzUnBiMjR1WEc0Z0lDQWdJQ0J1WlhoMExtUnZibVVnUFNCMGNuVmxPMXh1SUNBZ0lDQWdjbVYwZFhKdUlHNWxlSFE3WEc0Z0lDQWdmVHRjYmlBZ2ZUdGNibHh1SUNCbWRXNWpkR2x2YmlCMllXeDFaWE1vYVhSbGNtRmliR1VwSUh0Y2JpQWdJQ0JwWmlBb2FYUmxjbUZpYkdVcElIdGNiaUFnSUNBZ0lIWmhjaUJwZEdWeVlYUnZjazFsZEdodlpDQTlJR2wwWlhKaFlteGxXMmwwWlhKaGRHOXlVM2x0WW05c1hUdGNiaUFnSUNBZ0lHbG1JQ2hwZEdWeVlYUnZjazFsZEdodlpDa2dlMXh1SUNBZ0lDQWdJQ0J5WlhSMWNtNGdhWFJsY21GMGIzSk5aWFJvYjJRdVkyRnNiQ2hwZEdWeVlXSnNaU2s3WEc0Z0lDQWdJQ0I5WEc1Y2JpQWdJQ0FnSUdsbUlDaDBlWEJsYjJZZ2FYUmxjbUZpYkdVdWJtVjRkQ0E5UFQwZ1hDSm1kVzVqZEdsdmJsd2lLU0I3WEc0Z0lDQWdJQ0FnSUhKbGRIVnliaUJwZEdWeVlXSnNaVHRjYmlBZ0lDQWdJSDFjYmx4dUlDQWdJQ0FnYVdZZ0tDRnBjMDVoVGlocGRHVnlZV0pzWlM1c1pXNW5kR2dwS1NCN1hHNGdJQ0FnSUNBZ0lIWmhjaUJwSUQwZ0xURXNJRzVsZUhRZ1BTQm1kVzVqZEdsdmJpQnVaWGgwS0NrZ2UxeHVJQ0FnSUNBZ0lDQWdJSGRvYVd4bElDZ3JLMmtnUENCcGRHVnlZV0pzWlM1c1pXNW5kR2dwSUh0Y2JpQWdJQ0FnSUNBZ0lDQWdJR2xtSUNob1lYTlBkMjR1WTJGc2JDaHBkR1Z5WVdKc1pTd2dhU2twSUh0Y2JpQWdJQ0FnSUNBZ0lDQWdJQ0FnYm1WNGRDNTJZV3gxWlNBOUlHbDBaWEpoWW14bFcybGRPMXh1SUNBZ0lDQWdJQ0FnSUNBZ0lDQnVaWGgwTG1SdmJtVWdQU0JtWVd4elpUdGNiaUFnSUNBZ0lDQWdJQ0FnSUNBZ2NtVjBkWEp1SUc1bGVIUTdYRzRnSUNBZ0lDQWdJQ0FnSUNCOVhHNGdJQ0FnSUNBZ0lDQWdmVnh1WEc0Z0lDQWdJQ0FnSUNBZ2JtVjRkQzUyWVd4MVpTQTlJSFZ1WkdWbWFXNWxaRHRjYmlBZ0lDQWdJQ0FnSUNCdVpYaDBMbVJ2Ym1VZ1BTQjBjblZsTzF4dVhHNGdJQ0FnSUNBZ0lDQWdjbVYwZFhKdUlHNWxlSFE3WEc0Z0lDQWdJQ0FnSUgwN1hHNWNiaUFnSUNBZ0lDQWdjbVYwZFhKdUlHNWxlSFF1Ym1WNGRDQTlJRzVsZUhRN1hHNGdJQ0FnSUNCOVhHNGdJQ0FnZlZ4dVhHNGdJQ0FnTHk4Z1VtVjBkWEp1SUdGdUlHbDBaWEpoZEc5eUlIZHBkR2dnYm04Z2RtRnNkV1Z6TGx4dUlDQWdJSEpsZEhWeWJpQjdJRzVsZUhRNklHUnZibVZTWlhOMWJIUWdmVHRjYmlBZ2ZWeHVJQ0JsZUhCdmNuUnpMblpoYkhWbGN5QTlJSFpoYkhWbGN6dGNibHh1SUNCbWRXNWpkR2x2YmlCa2IyNWxVbVZ6ZFd4MEtDa2dlMXh1SUNBZ0lISmxkSFZ5YmlCN0lIWmhiSFZsT2lCMWJtUmxabWx1WldRc0lHUnZibVU2SUhSeWRXVWdmVHRjYmlBZ2ZWeHVYRzRnSUVOdmJuUmxlSFF1Y0hKdmRHOTBlWEJsSUQwZ2UxeHVJQ0FnSUdOdmJuTjBjblZqZEc5eU9pQkRiMjUwWlhoMExGeHVYRzRnSUNBZ2NtVnpaWFE2SUdaMWJtTjBhVzl1S0hOcmFYQlVaVzF3VW1WelpYUXBJSHRjYmlBZ0lDQWdJSFJvYVhNdWNISmxkaUE5SURBN1hHNGdJQ0FnSUNCMGFHbHpMbTVsZUhRZ1BTQXdPMXh1SUNBZ0lDQWdMeThnVW1WelpYUjBhVzVuSUdOdmJuUmxlSFF1WDNObGJuUWdabTl5SUd4bFoyRmplU0J6ZFhCd2IzSjBJRzltSUVKaFltVnNKM05jYmlBZ0lDQWdJQzh2SUdaMWJtTjBhVzl1TG5ObGJuUWdhVzF3YkdWdFpXNTBZWFJwYjI0dVhHNGdJQ0FnSUNCMGFHbHpMbk5sYm5RZ1BTQjBhR2x6TGw5elpXNTBJRDBnZFc1a1pXWnBibVZrTzF4dUlDQWdJQ0FnZEdocGN5NWtiMjVsSUQwZ1ptRnNjMlU3WEc0Z0lDQWdJQ0IwYUdsekxtUmxiR1ZuWVhSbElEMGdiblZzYkR0Y2JseHVJQ0FnSUNBZ2RHaHBjeTV0WlhSb2IyUWdQU0JjSW01bGVIUmNJanRjYmlBZ0lDQWdJSFJvYVhNdVlYSm5JRDBnZFc1a1pXWnBibVZrTzF4dVhHNGdJQ0FnSUNCMGFHbHpMblJ5ZVVWdWRISnBaWE11Wm05eVJXRmphQ2h5WlhObGRGUnllVVZ1ZEhKNUtUdGNibHh1SUNBZ0lDQWdhV1lnS0NGemEybHdWR1Z0Y0ZKbGMyVjBLU0I3WEc0Z0lDQWdJQ0FnSUdadmNpQW9kbUZ5SUc1aGJXVWdhVzRnZEdocGN5a2dlMXh1SUNBZ0lDQWdJQ0FnSUM4dklFNXZkQ0J6ZFhKbElHRmliM1YwSUhSb1pTQnZjSFJwYldGc0lHOXlaR1Z5SUc5bUlIUm9aWE5sSUdOdmJtUnBkR2x2Ym5NNlhHNGdJQ0FnSUNBZ0lDQWdhV1lnS0c1aGJXVXVZMmhoY2tGMEtEQXBJRDA5UFNCY0luUmNJaUFtSmx4dUlDQWdJQ0FnSUNBZ0lDQWdJQ0JvWVhOUGQyNHVZMkZzYkNoMGFHbHpMQ0J1WVcxbEtTQW1KbHh1SUNBZ0lDQWdJQ0FnSUNBZ0lDQWhhWE5PWVU0b0syNWhiV1V1YzJ4cFkyVW9NU2twS1NCN1hHNGdJQ0FnSUNBZ0lDQWdJQ0IwYUdselcyNWhiV1ZkSUQwZ2RXNWtaV1pwYm1Wa08xeHVJQ0FnSUNBZ0lDQWdJSDFjYmlBZ0lDQWdJQ0FnZlZ4dUlDQWdJQ0FnZlZ4dUlDQWdJSDBzWEc1Y2JpQWdJQ0J6ZEc5d09pQm1kVzVqZEdsdmJpZ3BJSHRjYmlBZ0lDQWdJSFJvYVhNdVpHOXVaU0E5SUhSeWRXVTdYRzVjYmlBZ0lDQWdJSFpoY2lCeWIyOTBSVzUwY25rZ1BTQjBhR2x6TG5SeWVVVnVkSEpwWlhOYk1GMDdYRzRnSUNBZ0lDQjJZWElnY205dmRGSmxZMjl5WkNBOUlISnZiM1JGYm5SeWVTNWpiMjF3YkdWMGFXOXVPMXh1SUNBZ0lDQWdhV1lnS0hKdmIzUlNaV052Y21RdWRIbHdaU0E5UFQwZ1hDSjBhSEp2ZDF3aUtTQjdYRzRnSUNBZ0lDQWdJSFJvY205M0lISnZiM1JTWldOdmNtUXVZWEpuTzF4dUlDQWdJQ0FnZlZ4dVhHNGdJQ0FnSUNCeVpYUjFjbTRnZEdocGN5NXlkbUZzTzF4dUlDQWdJSDBzWEc1Y2JpQWdJQ0JrYVhOd1lYUmphRVY0WTJWd2RHbHZiam9nWm5WdVkzUnBiMjRvWlhoalpYQjBhVzl1S1NCN1hHNGdJQ0FnSUNCcFppQW9kR2hwY3k1a2IyNWxLU0I3WEc0Z0lDQWdJQ0FnSUhSb2NtOTNJR1Y0WTJWd2RHbHZianRjYmlBZ0lDQWdJSDFjYmx4dUlDQWdJQ0FnZG1GeUlHTnZiblJsZUhRZ1BTQjBhR2x6TzF4dUlDQWdJQ0FnWm5WdVkzUnBiMjRnYUdGdVpHeGxLR3h2WXl3Z1kyRjFaMmgwS1NCN1hHNGdJQ0FnSUNBZ0lISmxZMjl5WkM1MGVYQmxJRDBnWENKMGFISnZkMXdpTzF4dUlDQWdJQ0FnSUNCeVpXTnZjbVF1WVhKbklEMGdaWGhqWlhCMGFXOXVPMXh1SUNBZ0lDQWdJQ0JqYjI1MFpYaDBMbTVsZUhRZ1BTQnNiMk03WEc1Y2JpQWdJQ0FnSUNBZ2FXWWdLR05oZFdkb2RDa2dlMXh1SUNBZ0lDQWdJQ0FnSUM4dklFbG1JSFJvWlNCa2FYTndZWFJqYUdWa0lHVjRZMlZ3ZEdsdmJpQjNZWE1nWTJGMVoyaDBJR0o1SUdFZ1kyRjBZMmdnWW14dlkyc3NYRzRnSUNBZ0lDQWdJQ0FnTHk4Z2RHaGxiaUJzWlhRZ2RHaGhkQ0JqWVhSamFDQmliRzlqYXlCb1lXNWtiR1VnZEdobElHVjRZMlZ3ZEdsdmJpQnViM0p0WVd4c2VTNWNiaUFnSUNBZ0lDQWdJQ0JqYjI1MFpYaDBMbTFsZEdodlpDQTlJRndpYm1WNGRGd2lPMXh1SUNBZ0lDQWdJQ0FnSUdOdmJuUmxlSFF1WVhKbklEMGdkVzVrWldacGJtVmtPMXh1SUNBZ0lDQWdJQ0I5WEc1Y2JpQWdJQ0FnSUNBZ2NtVjBkWEp1SUNFaElHTmhkV2RvZER0Y2JpQWdJQ0FnSUgxY2JseHVJQ0FnSUNBZ1ptOXlJQ2gyWVhJZ2FTQTlJSFJvYVhNdWRISjVSVzUwY21sbGN5NXNaVzVuZEdnZ0xTQXhPeUJwSUQ0OUlEQTdJQzB0YVNrZ2UxeHVJQ0FnSUNBZ0lDQjJZWElnWlc1MGNua2dQU0IwYUdsekxuUnllVVZ1ZEhKcFpYTmJhVjA3WEc0Z0lDQWdJQ0FnSUhaaGNpQnlaV052Y21RZ1BTQmxiblJ5ZVM1amIyMXdiR1YwYVc5dU8xeHVYRzRnSUNBZ0lDQWdJR2xtSUNobGJuUnllUzUwY25sTWIyTWdQVDA5SUZ3aWNtOXZkRndpS1NCN1hHNGdJQ0FnSUNBZ0lDQWdMeThnUlhoalpYQjBhVzl1SUhSb2NtOTNiaUJ2ZFhSemFXUmxJRzltSUdGdWVTQjBjbmtnWW14dlkyc2dkR2hoZENCamIzVnNaQ0JvWVc1a2JHVmNiaUFnSUNBZ0lDQWdJQ0F2THlCcGRDd2djMjhnYzJWMElIUm9aU0JqYjIxd2JHVjBhVzl1SUhaaGJIVmxJRzltSUhSb1pTQmxiblJwY21VZ1puVnVZM1JwYjI0Z2RHOWNiaUFnSUNBZ0lDQWdJQ0F2THlCMGFISnZkeUIwYUdVZ1pYaGpaWEIwYVc5dUxseHVJQ0FnSUNBZ0lDQWdJSEpsZEhWeWJpQm9ZVzVrYkdVb1hDSmxibVJjSWlrN1hHNGdJQ0FnSUNBZ0lIMWNibHh1SUNBZ0lDQWdJQ0JwWmlBb1pXNTBjbmt1ZEhKNVRHOWpJRHc5SUhSb2FYTXVjSEpsZGlrZ2UxeHVJQ0FnSUNBZ0lDQWdJSFpoY2lCb1lYTkRZWFJqYUNBOUlHaGhjMDkzYmk1allXeHNLR1Z1ZEhKNUxDQmNJbU5oZEdOb1RHOWpYQ0lwTzF4dUlDQWdJQ0FnSUNBZ0lIWmhjaUJvWVhOR2FXNWhiR3g1SUQwZ2FHRnpUM2R1TG1OaGJHd29aVzUwY25rc0lGd2labWx1WVd4c2VVeHZZMXdpS1R0Y2JseHVJQ0FnSUNBZ0lDQWdJR2xtSUNob1lYTkRZWFJqYUNBbUppQm9ZWE5HYVc1aGJHeDVLU0I3WEc0Z0lDQWdJQ0FnSUNBZ0lDQnBaaUFvZEdocGN5NXdjbVYySUR3Z1pXNTBjbmt1WTJGMFkyaE1iMk1wSUh0Y2JpQWdJQ0FnSUNBZ0lDQWdJQ0FnY21WMGRYSnVJR2hoYm1Sc1pTaGxiblJ5ZVM1allYUmphRXh2WXl3Z2RISjFaU2s3WEc0Z0lDQWdJQ0FnSUNBZ0lDQjlJR1ZzYzJVZ2FXWWdLSFJvYVhNdWNISmxkaUE4SUdWdWRISjVMbVpwYm1Gc2JIbE1iMk1wSUh0Y2JpQWdJQ0FnSUNBZ0lDQWdJQ0FnY21WMGRYSnVJR2hoYm1Sc1pTaGxiblJ5ZVM1bWFXNWhiR3g1VEc5aktUdGNiaUFnSUNBZ0lDQWdJQ0FnSUgxY2JseHVJQ0FnSUNBZ0lDQWdJSDBnWld4elpTQnBaaUFvYUdGelEyRjBZMmdwSUh0Y2JpQWdJQ0FnSUNBZ0lDQWdJR2xtSUNoMGFHbHpMbkJ5WlhZZ1BDQmxiblJ5ZVM1allYUmphRXh2WXlrZ2UxeHVJQ0FnSUNBZ0lDQWdJQ0FnSUNCeVpYUjFjbTRnYUdGdVpHeGxLR1Z1ZEhKNUxtTmhkR05vVEc5akxDQjBjblZsS1R0Y2JpQWdJQ0FnSUNBZ0lDQWdJSDFjYmx4dUlDQWdJQ0FnSUNBZ0lIMGdaV3h6WlNCcFppQW9hR0Z6Um1sdVlXeHNlU2tnZTF4dUlDQWdJQ0FnSUNBZ0lDQWdhV1lnS0hSb2FYTXVjSEpsZGlBOElHVnVkSEo1TG1acGJtRnNiSGxNYjJNcElIdGNiaUFnSUNBZ0lDQWdJQ0FnSUNBZ2NtVjBkWEp1SUdoaGJtUnNaU2hsYm5SeWVTNW1hVzVoYkd4NVRHOWpLVHRjYmlBZ0lDQWdJQ0FnSUNBZ0lIMWNibHh1SUNBZ0lDQWdJQ0FnSUgwZ1pXeHpaU0I3WEc0Z0lDQWdJQ0FnSUNBZ0lDQjBhSEp2ZHlCdVpYY2dSWEp5YjNJb1hDSjBjbmtnYzNSaGRHVnRaVzUwSUhkcGRHaHZkWFFnWTJGMFkyZ2diM0lnWm1sdVlXeHNlVndpS1R0Y2JpQWdJQ0FnSUNBZ0lDQjlYRzRnSUNBZ0lDQWdJSDFjYmlBZ0lDQWdJSDFjYmlBZ0lDQjlMRnh1WEc0Z0lDQWdZV0p5ZFhCME9pQm1kVzVqZEdsdmJpaDBlWEJsTENCaGNtY3BJSHRjYmlBZ0lDQWdJR1p2Y2lBb2RtRnlJR2tnUFNCMGFHbHpMblJ5ZVVWdWRISnBaWE11YkdWdVozUm9JQzBnTVRzZ2FTQStQU0F3T3lBdExXa3BJSHRjYmlBZ0lDQWdJQ0FnZG1GeUlHVnVkSEo1SUQwZ2RHaHBjeTUwY25sRmJuUnlhV1Z6VzJsZE8xeHVJQ0FnSUNBZ0lDQnBaaUFvWlc1MGNua3VkSEo1VEc5aklEdzlJSFJvYVhNdWNISmxkaUFtSmx4dUlDQWdJQ0FnSUNBZ0lDQWdhR0Z6VDNkdUxtTmhiR3dvWlc1MGNua3NJRndpWm1sdVlXeHNlVXh2WTF3aUtTQW1KbHh1SUNBZ0lDQWdJQ0FnSUNBZ2RHaHBjeTV3Y21WMklEd2daVzUwY25rdVptbHVZV3hzZVV4dll5a2dlMXh1SUNBZ0lDQWdJQ0FnSUhaaGNpQm1hVzVoYkd4NVJXNTBjbmtnUFNCbGJuUnllVHRjYmlBZ0lDQWdJQ0FnSUNCaWNtVmhhenRjYmlBZ0lDQWdJQ0FnZlZ4dUlDQWdJQ0FnZlZ4dVhHNGdJQ0FnSUNCcFppQW9abWx1WVd4c2VVVnVkSEo1SUNZbVhHNGdJQ0FnSUNBZ0lDQWdLSFI1Y0dVZ1BUMDlJRndpWW5KbFlXdGNJaUI4ZkZ4dUlDQWdJQ0FnSUNBZ0lDQjBlWEJsSUQwOVBTQmNJbU52Ym5ScGJuVmxYQ0lwSUNZbVhHNGdJQ0FnSUNBZ0lDQWdabWx1WVd4c2VVVnVkSEo1TG5SeWVVeHZZeUE4UFNCaGNtY2dKaVpjYmlBZ0lDQWdJQ0FnSUNCaGNtY2dQRDBnWm1sdVlXeHNlVVZ1ZEhKNUxtWnBibUZzYkhsTWIyTXBJSHRjYmlBZ0lDQWdJQ0FnTHk4Z1NXZHViM0psSUhSb1pTQm1hVzVoYkd4NUlHVnVkSEo1SUdsbUlHTnZiblJ5YjJ3Z2FYTWdibTkwSUdwMWJYQnBibWNnZEc4Z1lWeHVJQ0FnSUNBZ0lDQXZMeUJzYjJOaGRHbHZiaUJ2ZFhSemFXUmxJSFJvWlNCMGNua3ZZMkYwWTJnZ1lteHZZMnN1WEc0Z0lDQWdJQ0FnSUdacGJtRnNiSGxGYm5SeWVTQTlJRzUxYkd3N1hHNGdJQ0FnSUNCOVhHNWNiaUFnSUNBZ0lIWmhjaUJ5WldOdmNtUWdQU0JtYVc1aGJHeDVSVzUwY25rZ1B5Qm1hVzVoYkd4NVJXNTBjbmt1WTI5dGNHeGxkR2x2YmlBNklIdDlPMXh1SUNBZ0lDQWdjbVZqYjNKa0xuUjVjR1VnUFNCMGVYQmxPMXh1SUNBZ0lDQWdjbVZqYjNKa0xtRnlaeUE5SUdGeVp6dGNibHh1SUNBZ0lDQWdhV1lnS0dacGJtRnNiSGxGYm5SeWVTa2dlMXh1SUNBZ0lDQWdJQ0IwYUdsekxtMWxkR2h2WkNBOUlGd2libVY0ZEZ3aU8xeHVJQ0FnSUNBZ0lDQjBhR2x6TG01bGVIUWdQU0JtYVc1aGJHeDVSVzUwY25rdVptbHVZV3hzZVV4dll6dGNiaUFnSUNBZ0lDQWdjbVYwZFhKdUlFTnZiblJwYm5WbFUyVnVkR2x1Wld3N1hHNGdJQ0FnSUNCOVhHNWNiaUFnSUNBZ0lISmxkSFZ5YmlCMGFHbHpMbU52YlhCc1pYUmxLSEpsWTI5eVpDazdYRzRnSUNBZ2ZTeGNibHh1SUNBZ0lHTnZiWEJzWlhSbE9pQm1kVzVqZEdsdmJpaHlaV052Y21Rc0lHRm1kR1Z5VEc5aktTQjdYRzRnSUNBZ0lDQnBaaUFvY21WamIzSmtMblI1Y0dVZ1BUMDlJRndpZEdoeWIzZGNJaWtnZTF4dUlDQWdJQ0FnSUNCMGFISnZkeUJ5WldOdmNtUXVZWEpuTzF4dUlDQWdJQ0FnZlZ4dVhHNGdJQ0FnSUNCcFppQW9jbVZqYjNKa0xuUjVjR1VnUFQwOUlGd2lZbkpsWVd0Y0lpQjhmRnh1SUNBZ0lDQWdJQ0FnSUhKbFkyOXlaQzUwZVhCbElEMDlQU0JjSW1OdmJuUnBiblZsWENJcElIdGNiaUFnSUNBZ0lDQWdkR2hwY3k1dVpYaDBJRDBnY21WamIzSmtMbUZ5Wnp0Y2JpQWdJQ0FnSUgwZ1pXeHpaU0JwWmlBb2NtVmpiM0prTG5SNWNHVWdQVDA5SUZ3aWNtVjBkWEp1WENJcElIdGNiaUFnSUNBZ0lDQWdkR2hwY3k1eWRtRnNJRDBnZEdocGN5NWhjbWNnUFNCeVpXTnZjbVF1WVhKbk8xeHVJQ0FnSUNBZ0lDQjBhR2x6TG0xbGRHaHZaQ0E5SUZ3aWNtVjBkWEp1WENJN1hHNGdJQ0FnSUNBZ0lIUm9hWE11Ym1WNGRDQTlJRndpWlc1a1hDSTdYRzRnSUNBZ0lDQjlJR1ZzYzJVZ2FXWWdLSEpsWTI5eVpDNTBlWEJsSUQwOVBTQmNJbTV2Y20xaGJGd2lJQ1ltSUdGbWRHVnlURzlqS1NCN1hHNGdJQ0FnSUNBZ0lIUm9hWE11Ym1WNGRDQTlJR0ZtZEdWeVRHOWpPMXh1SUNBZ0lDQWdmVnh1WEc0Z0lDQWdJQ0J5WlhSMWNtNGdRMjl1ZEdsdWRXVlRaVzUwYVc1bGJEdGNiaUFnSUNCOUxGeHVYRzRnSUNBZ1ptbHVhWE5vT2lCbWRXNWpkR2x2YmlobWFXNWhiR3g1VEc5aktTQjdYRzRnSUNBZ0lDQm1iM0lnS0haaGNpQnBJRDBnZEdocGN5NTBjbmxGYm5SeWFXVnpMbXhsYm1kMGFDQXRJREU3SUdrZ1BqMGdNRHNnTFMxcEtTQjdYRzRnSUNBZ0lDQWdJSFpoY2lCbGJuUnllU0E5SUhSb2FYTXVkSEo1Ulc1MGNtbGxjMXRwWFR0Y2JpQWdJQ0FnSUNBZ2FXWWdLR1Z1ZEhKNUxtWnBibUZzYkhsTWIyTWdQVDA5SUdacGJtRnNiSGxNYjJNcElIdGNiaUFnSUNBZ0lDQWdJQ0IwYUdsekxtTnZiWEJzWlhSbEtHVnVkSEo1TG1OdmJYQnNaWFJwYjI0c0lHVnVkSEo1TG1GbWRHVnlURzlqS1R0Y2JpQWdJQ0FnSUNBZ0lDQnlaWE5sZEZSeWVVVnVkSEo1S0dWdWRISjVLVHRjYmlBZ0lDQWdJQ0FnSUNCeVpYUjFjbTRnUTI5dWRHbHVkV1ZUWlc1MGFXNWxiRHRjYmlBZ0lDQWdJQ0FnZlZ4dUlDQWdJQ0FnZlZ4dUlDQWdJSDBzWEc1Y2JpQWdJQ0JjSW1OaGRHTm9YQ0k2SUdaMWJtTjBhVzl1S0hSeWVVeHZZeWtnZTF4dUlDQWdJQ0FnWm05eUlDaDJZWElnYVNBOUlIUm9hWE11ZEhKNVJXNTBjbWxsY3k1c1pXNW5kR2dnTFNBeE95QnBJRDQ5SURBN0lDMHRhU2tnZTF4dUlDQWdJQ0FnSUNCMllYSWdaVzUwY25rZ1BTQjBhR2x6TG5SeWVVVnVkSEpwWlhOYmFWMDdYRzRnSUNBZ0lDQWdJR2xtSUNobGJuUnllUzUwY25sTWIyTWdQVDA5SUhSeWVVeHZZeWtnZTF4dUlDQWdJQ0FnSUNBZ0lIWmhjaUJ5WldOdmNtUWdQU0JsYm5SeWVTNWpiMjF3YkdWMGFXOXVPMXh1SUNBZ0lDQWdJQ0FnSUdsbUlDaHlaV052Y21RdWRIbHdaU0E5UFQwZ1hDSjBhSEp2ZDF3aUtTQjdYRzRnSUNBZ0lDQWdJQ0FnSUNCMllYSWdkR2h5YjNkdUlEMGdjbVZqYjNKa0xtRnlaenRjYmlBZ0lDQWdJQ0FnSUNBZ0lISmxjMlYwVkhKNVJXNTBjbmtvWlc1MGNua3BPMXh1SUNBZ0lDQWdJQ0FnSUgxY2JpQWdJQ0FnSUNBZ0lDQnlaWFIxY200Z2RHaHliM2R1TzF4dUlDQWdJQ0FnSUNCOVhHNGdJQ0FnSUNCOVhHNWNiaUFnSUNBZ0lDOHZJRlJvWlNCamIyNTBaWGgwTG1OaGRHTm9JRzFsZEdodlpDQnRkWE4wSUc5dWJIa2dZbVVnWTJGc2JHVmtJSGRwZEdnZ1lTQnNiMk5oZEdsdmJseHVJQ0FnSUNBZ0x5OGdZWEpuZFcxbGJuUWdkR2hoZENCamIzSnlaWE53YjI1a2N5QjBieUJoSUd0dWIzZHVJR05oZEdOb0lHSnNiMk5yTGx4dUlDQWdJQ0FnZEdoeWIzY2dibVYzSUVWeWNtOXlLRndpYVd4c1pXZGhiQ0JqWVhSamFDQmhkSFJsYlhCMFhDSXBPMXh1SUNBZ0lIMHNYRzVjYmlBZ0lDQmtaV3hsWjJGMFpWbHBaV3hrT2lCbWRXNWpkR2x2YmlocGRHVnlZV0pzWlN3Z2NtVnpkV3gwVG1GdFpTd2dibVY0ZEV4dll5a2dlMXh1SUNBZ0lDQWdkR2hwY3k1a1pXeGxaMkYwWlNBOUlIdGNiaUFnSUNBZ0lDQWdhWFJsY21GMGIzSTZJSFpoYkhWbGN5aHBkR1Z5WVdKc1pTa3NYRzRnSUNBZ0lDQWdJSEpsYzNWc2RFNWhiV1U2SUhKbGMzVnNkRTVoYldVc1hHNGdJQ0FnSUNBZ0lHNWxlSFJNYjJNNklHNWxlSFJNYjJOY2JpQWdJQ0FnSUgwN1hHNWNiaUFnSUNBZ0lHbG1JQ2gwYUdsekxtMWxkR2h2WkNBOVBUMGdYQ0p1WlhoMFhDSXBJSHRjYmlBZ0lDQWdJQ0FnTHk4Z1JHVnNhV0psY21GMFpXeDVJR1p2Y21kbGRDQjBhR1VnYkdGemRDQnpaVzUwSUhaaGJIVmxJSE52SUhSb1lYUWdkMlVnWkc5dUozUmNiaUFnSUNBZ0lDQWdMeThnWVdOamFXUmxiblJoYkd4NUlIQmhjM01nYVhRZ2IyNGdkRzhnZEdobElHUmxiR1ZuWVhSbExseHVJQ0FnSUNBZ0lDQjBhR2x6TG1GeVp5QTlJSFZ1WkdWbWFXNWxaRHRjYmlBZ0lDQWdJSDFjYmx4dUlDQWdJQ0FnY21WMGRYSnVJRU52Ym5ScGJuVmxVMlZ1ZEdsdVpXdzdYRzRnSUNBZ2ZWeHVJQ0I5TzF4dVhHNGdJQzh2SUZKbFoyRnlaR3hsYzNNZ2IyWWdkMmhsZEdobGNpQjBhR2x6SUhOamNtbHdkQ0JwY3lCbGVHVmpkWFJwYm1jZ1lYTWdZU0JEYjIxdGIyNUtVeUJ0YjJSMWJHVmNiaUFnTHk4Z2IzSWdibTkwTENCeVpYUjFjbTRnZEdobElISjFiblJwYldVZ2IySnFaV04wSUhOdklIUm9ZWFFnZDJVZ1kyRnVJR1JsWTJ4aGNtVWdkR2hsSUhaaGNtbGhZbXhsWEc0Z0lDOHZJSEpsWjJWdVpYSmhkRzl5VW5WdWRHbHRaU0JwYmlCMGFHVWdiM1YwWlhJZ2MyTnZjR1VzSUhkb2FXTm9JR0ZzYkc5M2N5QjBhR2x6SUcxdlpIVnNaU0IwYnlCaVpWeHVJQ0F2THlCcGJtcGxZM1JsWkNCbFlYTnBiSGtnWW5rZ1lHSnBiaTl5WldkbGJtVnlZWFJ2Y2lBdExXbHVZMngxWkdVdGNuVnVkR2x0WlNCelkzSnBjSFF1YW5OZ0xseHVJQ0J5WlhSMWNtNGdaWGh3YjNKMGN6dGNibHh1ZlNoY2JpQWdMeThnU1dZZ2RHaHBjeUJ6WTNKcGNIUWdhWE1nWlhobFkzVjBhVzVuSUdGeklHRWdRMjl0Ylc5dVNsTWdiVzlrZFd4bExDQjFjMlVnYlc5a2RXeGxMbVY0Y0c5eWRITmNiaUFnTHk4Z1lYTWdkR2hsSUhKbFoyVnVaWEpoZEc5eVVuVnVkR2x0WlNCdVlXMWxjM0JoWTJVdUlFOTBhR1Z5ZDJselpTQmpjbVZoZEdVZ1lTQnVaWGNnWlcxd2RIbGNiaUFnTHk4Z2IySnFaV04wTGlCRmFYUm9aWElnZDJGNUxDQjBhR1VnY21WemRXeDBhVzVuSUc5aWFtVmpkQ0IzYVd4c0lHSmxJSFZ6WldRZ2RHOGdhVzVwZEdsaGJHbDZaVnh1SUNBdkx5QjBhR1VnY21WblpXNWxjbUYwYjNKU2RXNTBhVzFsSUhaaGNtbGhZbXhsSUdGMElIUm9aU0IwYjNBZ2IyWWdkR2hwY3lCbWFXeGxMbHh1SUNCMGVYQmxiMllnYlc5a2RXeGxJRDA5UFNCY0ltOWlhbVZqZEZ3aUlEOGdiVzlrZFd4bExtVjRjRzl5ZEhNZ09pQjdmVnh1S1NrN1hHNWNiblJ5ZVNCN1hHNGdJSEpsWjJWdVpYSmhkRzl5VW5WdWRHbHRaU0E5SUhKMWJuUnBiV1U3WEc1OUlHTmhkR05vSUNoaFkyTnBaR1Z1ZEdGc1UzUnlhV04wVFc5a1pTa2dlMXh1SUNBdkx5QlVhR2x6SUcxdlpIVnNaU0J6YUc5MWJHUWdibTkwSUdKbElISjFibTVwYm1jZ2FXNGdjM1J5YVdOMElHMXZaR1VzSUhOdklIUm9aU0JoWW05MlpWeHVJQ0F2THlCaGMzTnBaMjV0Wlc1MElITm9iM1ZzWkNCaGJIZGhlWE1nZDI5eWF5QjFibXhsYzNNZ2MyOXRaWFJvYVc1bklHbHpJRzFwYzJOdmJtWnBaM1Z5WldRdUlFcDFjM1JjYmlBZ0x5OGdhVzRnWTJGelpTQnlkVzUwYVcxbExtcHpJR0ZqWTJsa1pXNTBZV3hzZVNCeWRXNXpJR2x1SUhOMGNtbGpkQ0J0YjJSbExDQjNaU0JqWVc0Z1pYTmpZWEJsWEc0Z0lDOHZJSE4wY21samRDQnRiMlJsSUhWemFXNW5JR0VnWjJ4dlltRnNJRVoxYm1OMGFXOXVJR05oYkd3dUlGUm9hWE1nWTI5MWJHUWdZMjl1WTJWcGRtRmliSGtnWm1GcGJGeHVJQ0F2THlCcFppQmhJRU52Ym5SbGJuUWdVMlZqZFhKcGRIa2dVRzlzYVdONUlHWnZjbUpwWkhNZ2RYTnBibWNnUm5WdVkzUnBiMjRzSUdKMWRDQnBiaUIwYUdGMElHTmhjMlZjYmlBZ0x5OGdkR2hsSUhCeWIzQmxjaUJ6YjJ4MWRHbHZiaUJwY3lCMGJ5Qm1hWGdnZEdobElHRmpZMmxrWlc1MFlXd2djM1J5YVdOMElHMXZaR1VnY0hKdllteGxiUzRnU1daY2JpQWdMeThnZVc5MUozWmxJRzFwYzJOdmJtWnBaM1Z5WldRZ2VXOTFjaUJpZFc1a2JHVnlJSFJ2SUdadmNtTmxJSE4wY21samRDQnRiMlJsSUdGdVpDQmhjSEJzYVdWa0lHRmNiaUFnTHk4Z1ExTlFJSFJ2SUdadmNtSnBaQ0JHZFc1amRHbHZiaXdnWVc1a0lIbHZkU2R5WlNCdWIzUWdkMmxzYkdsdVp5QjBieUJtYVhnZ1pXbDBhR1Z5SUc5bUlIUm9iM05sWEc0Z0lDOHZJSEJ5YjJKc1pXMXpMQ0J3YkdWaGMyVWdaR1YwWVdsc0lIbHZkWElnZFc1cGNYVmxJSEJ5WldScFkyRnRaVzUwSUdsdUlHRWdSMmwwU0hWaUlHbHpjM1ZsTGx4dUlDQkdkVzVqZEdsdmJpaGNJbkpjSWl3Z1hDSnlaV2RsYm1WeVlYUnZjbEoxYm5ScGJXVWdQU0J5WENJcEtISjFiblJwYldVcE8xeHVmVnh1SWl3aVkyOXVjM1FnY21WblpXNWxjbUYwYjNKU2RXNTBhVzFsSUQwZ2NtVnhkV2x5WlNoY0luSmxaMlZ1WlhKaGRHOXlMWEoxYm5ScGJXVmNJaWs3WEhKY2JseHlYRzVqYjI1emRDQjBiM0JzYVc1bElEMGdaRzlqZFcxbGJuUXVjWFZsY25sVFpXeGxZM1J2Y2loY0lpNXRaVzUxWENJcE8xeHlYRzVqYjI1emRDQnRiMkpwYkdWTlpXNTFJRDBnWkc5amRXMWxiblF1WjJWMFJXeGxiV1Z1ZEVKNVNXUW9YQ0p0YjJKcGJHVk5aVzUxWENJcE8xeHlYRzVqYjI1emRDQmpiRzl6WlVKMGJpQTlJR1J2WTNWdFpXNTBMbWRsZEVWc1pXMWxiblJDZVVsa0tGd2lZMnh2YzJWQ2RHNWNJaWs3WEhKY2JtTnZibk4wSUdKMWNtZGxjaUE5SUdSdlkzVnRaVzUwTG1kbGRFVnNaVzFsYm5SQ2VVbGtLRndpWW5WeVoyVnlYQ0lwTzF4eVhHNWpiMjV6ZENCdGIySnBiR1ZNYVhOMElEMGdaRzlqZFcxbGJuUXVaMlYwUld4bGJXVnVkRUo1U1dRb1hDSnRiMkpwYkdWTWFYTjBYQ0lwTzF4eVhHNWpiMjV6ZENCelpXVk5iM0psSUQwZ1pHOWpkVzFsYm5RdVoyVjBSV3hsYldWdWRFSjVTV1FvWENKelpXVk5iM0psWENJcE8xeHlYRzVqYjI1emRDQmhZMk52Y21SbGIyNGdQU0JrYjJOMWJXVnVkQzVuWlhSRmJHVnRaVzUwUW5sSlpDaGNJbUZqWTI5eVpHVnZibHdpS1R0Y2NseHVZMjl1YzNRZ2NtVmhaRTF2Y21VeElEMGdaRzlqZFcxbGJuUXVaMlYwUld4bGJXVnVkRUo1U1dRb1hDSnlaV0ZrVFc5eVpURmNJaWs3WEhKY2JtTnZibk4wSUhKbFlXUk5iM0psTWlBOUlHUnZZM1Z0Wlc1MExtZGxkRVZzWlcxbGJuUkNlVWxrS0Z3aWNtVmhaRTF2Y21VeVhDSXBPMXh5WEc1amIyNXpkQ0J5WldGa1RHVnpjekVnUFNCa2IyTjFiV1Z1ZEM1blpYUkZiR1Z0Wlc1MFFubEpaQ2hjSW5KbFlXUk1aWE56TVZ3aUtUdGNjbHh1WTI5dWMzUWdjbVZoWkV4bGMzTXlJRDBnWkc5amRXMWxiblF1WjJWMFJXeGxiV1Z1ZEVKNVNXUW9YQ0p5WldGa1RHVnpjekpjSWlrN1hISmNibU52Ym5OMElHeHBjM1JHYVhKemRDQTlJR1J2WTNWdFpXNTBMbWRsZEVWc1pXMWxiblJDZVVsa0tGd2liR2x6ZEVacGNuTjBYQ0lwTzF4eVhHNWpiMjV6ZENCMFpYaDBSbWx5YzNRZ1BTQmtiMk4xYldWdWRDNW5aWFJGYkdWdFpXNTBRbmxKWkNoY0luUmxlSFJHYVhKemRGd2lLVHRjY2x4dVkyOXVjM1FnZEdWNGRGTmxZMjl1WkNBOUlHUnZZM1Z0Wlc1MExtZGxkRVZzWlcxbGJuUkNlVWxrS0Z3aWRHVjRkRk5sWTI5dVpGd2lLVHRjY2x4dVkyOXVjM1FnWTJGeVpITWdQU0JrYjJOMWJXVnVkQzVuWlhSRmJHVnRaVzUwUW5sSlpDaGNJbU5oY21SelhDSXBPMXh5WEc1amIyNXpkQ0JqWVhKa1FXTjBhWFpsSUQwZ1pHOWpkVzFsYm5RdVoyVjBSV3hsYldWdWRFSjVTV1FvWENKallYSmtRV04wYVhabFhDSXBPMXh5WEc1c1pYUWdZMjkxYm5SbGNpQTlJRE03WEhKY2JteGxkQ0J5WVdselpYSWdQU0F6TzF4eVhHNWpiMjV6ZENCd2NtOWtkV04wY3lBOUlGdGNjbHh1SUNCN1hISmNiaUFnSUNCemNtTTZJRndpYVcxbkx6RXVJRWx1Wkc5dmNpNXFjR2RjSWl4Y2NseHVJQ0FnSUhOMVluUnBkR3hsT2lCY0lrbHVaRzl2Y2lCbGJtVnlaM2tnYzJWeWRtbGpaWE5jSWl4Y2NseHVJQ0FnSUhSbGVIUTZYSEpjYmlBZ0lDQWdJRndpVjJVZ2FHVnNjR1ZrSUVsdVpHOXZjaUJsYm1WeVoza2djMlZ5ZG1salpYTWdkRzhnWjNKbFlYUjVJSE5wYlhCc2FXWjVJSFJvWldseUlHTmhjMlVnYldGdVlXZGxiV1Z1ZENCemVYTjBaVzB1TGk1Y0lseHlYRzRnSUgwc1hISmNiaUFnZTF4eVhHNGdJQ0FnYzNKak9pQmNJbWx0Wnk4eUxpQkNhWEprYVdVdWFuQm5YQ0lzWEhKY2JpQWdJQ0J6ZFdKMGFYUnNaVG9nWENKQ2FYSmthV1VnUjI5c1pDQlViM1Z5YzF3aUxGeHlYRzRnSUNBZ2RHVjRkRHBjY2x4dUlDQWdJQ0FnWENKWFpTQm9aV3h3WldRZ1FtbHlaSGtnUjI5c1ppQlViM1Z5Y3lCMGJ5QnpkR0Y1SUhKbGJHVjJaV0Z1ZENCdmJpQmhiaUJwYm1Oc2NtVmhjMmx1WjJ4NUlHTnZiWEJsZEdsMGFYWmxJRzFoY210bGRDNHVMbHdpWEhKY2JpQWdmU3hjY2x4dUlDQjdYSEpjYmlBZ0lDQnpjbU02SUZ3aWFXMW5Mek11SUU1dmQxZG9aWEpsTG1wd1oxd2lMRnh5WEc0Z0lDQWdjM1ZpZEdsMGJHVTZJRndpVG05M1YyaGxjbVZjSWl4Y2NseHVJQ0FnSUhSbGVIUTZYSEpjYmlBZ0lDQWdJRndpVjJVZ1luVnBiSFFnWVNCeVpXTnZiVzFsYm1SaGRHbHZibk1nWVhCd0lHWnZjaUJ3Wlc5d2JHVWdkMjl5YTJsdVp5QnBiaUJqY21WaGRHbDJaU0JwYm1SMWMzUnlhV1Z6TGk0dVhDSmNjbHh1SUNCOUxGeHlYRzRnSUh0Y2NseHVJQ0FnSUhOeVl6b2dYQ0pwYldjdk5DNGdSbmx1WkdseGMzWmhhbkJsYmk1cWNHZGNJaXhjY2x4dUlDQWdJSE4xWW5ScGRHeGxPaUJjSWtaNWJtUnBjWE4yWVdwd1pXNWNJaXhjY2x4dUlDQWdJSFJsZUhRNlhISmNiaUFnSUNBZ0lGd2lWMlVnWTNKbFlYUmxaQ0JoYmlCaGNIQWdkR2hoZENCb1pXeHdaV1FnWTNWemRHOXRaWEp6SUdacGJtUWdaMmxtZEhNZ1lXMXZibWNnYlc5eVpTQjBhR0Z1SURJNU1EQXdNREFnYVhSbGJYTXVMaTVjSWx4eVhHNGdJSDBzWEhKY2JpQWdlMXh5WEc0Z0lDQWdjM0pqT2lCY0ltbHRaeTgxTGlCQ2VYUm9hblZzTG1wd1oxd2lMRnh5WEc0Z0lDQWdjM1ZpZEdsMGJHVTZJRndpUW5sMGFHcDFiRndpTEZ4eVhHNGdJQ0FnZEdWNGREcGNjbHh1SUNBZ0lDQWdYQ0pYWlNCamNtVmhkR1ZrSUhScGNtVWdabUZ6YUdsdmJpQm1iM0lnZEdobElHbHVZM0psWVhOcGJtZHNlU0JsWjJGc2FYUmhjbWxoYmlCallYSWdiV0ZwYm5ScGJtRmpaU0J0WVhKclpYUXVMaTVjSWx4eVhHNGdJSDBzWEhKY2JpQWdlMXh5WEc0Z0lDQWdjM0pqT2lCY0ltbHRaeTgyTGlCVWFXTnJhVzR1YW5CblhDSXNYSEpjYmlBZ0lDQnpkV0owYVhSc1pUb2dYQ0pVYVdOcmFXNWNJaXhjY2x4dUlDQWdJSFJsZUhRNlhISmNiaUFnSUNBZ0lGd2lWMlVnYVc1MlpXNTBaV1FnWVNCMGFXMWxJSEpsY0c5eWRHbHVaeUJ6ZVhOMFpXMGdabTl5SUhCbGIzQnNaU0IzYUc4Z2FHRjBaU0IwYVcxbElIUnlZV05yYVc1bkxpNHVYQ0pjY2x4dUlDQjlMRnh5WEc0Z0lIdGNjbHh1SUNBZ0lITnlZem9nWENKcGJXY3ZOeTRnVldKbGNtMWxaSE11YW5CblhDSXNYSEpjYmlBZ0lDQnpkV0owYVhSc1pUb2dYQ0pWWW1WeWJXVmtjMXdpTEZ4eVhHNGdJQ0FnZEdWNGREcGNjbHh1SUNBZ0lDQWdYQ0pYWlNCamNtVmhkR1ZrSUdGdUlHRndjQ0IwYUdGMElHaGxiSEJsWkNCamRYTjBiMjFsY25NZ1ptbHVaQ0JuYVdaMGN5QmhiVzl1WnlCdGIzSmxJSFJvWVc0Z01qa3dNREF3TUNCcGRHVnRjeTR1TGx3aVhISmNiaUFnZlN4Y2NseHVJQ0I3WEhKY2JpQWdJQ0J6Y21NNklGd2lhVzFuTHpndUlGYkRwSE4wZEhKaFptbHJJRU5oYkdOMWJHRjBiM0l1YW5CblhDSXNYSEpjYmlBZ0lDQnpkV0owYVhSc1pUb2dYQ0pXdzZSemRIUnlZV1pwYXlCRFlXeGpkV3hoZEc5eVhDSXNYSEpjYmlBZ0lDQjBaWGgwT2x4eVhHNGdJQ0FnSUNCY0lsZGxJR055WldGMFpXUWdkR2x5WlNCbVlYTm9hVzl1SUdadmNpQjBhR1VnYVc1amNtVmhjMmx1WjJ4NUlHVm5ZV3hwZEdGeWFXRnVJR05oY2lCdFlXbHVkR2x1WVdObElHMWhjbXRsZEM0dUxsd2lYSEpjYmlBZ2ZTeGNjbHh1SUNCN1hISmNiaUFnSUNCemNtTTZJRndpYVcxbkx6a3VJRlJ5dzZSdWFXNW5jM0JoY25SdVpYSXVhbkJuWENJc1hISmNiaUFnSUNCemRXSjBhWFJzWlRvZ1hDSlVjc09rYm1sdVozTndZWEowYm1WeVhDSXNYSEpjYmlBZ0lDQjBaWGgwT2x4eVhHNGdJQ0FnSUNCY0lsZGxJR2x1ZG1WdWRHVmtJR0VnZEdsdFpTQnlaWEJ2Y25ScGJtY2djM2x6ZEdWdElHWnZjaUJ3Wlc5d2JHVWdkMmh2SUdoaGRHVWdkR2x0WlNCMGNtRmphMmx1Wnk0dUxsd2lYSEpjYmlBZ2ZWeHlYRzVkTzF4eVhHNWNjbHh1Wkc5amRXMWxiblF1WVdSa1JYWmxiblJNYVhOMFpXNWxjaWhjSW5OamNtOXNiRndpTENBb0tTQTlQaUI3WEhKY2JpQWdhV1lnS0hkcGJtUnZkeTV3WVdkbFdVOW1abk5sZENBOElIUnZjR3hwYm1VdVkyeHBaVzUwU0dWcFoyaDBLU0I3WEhKY2JpQWdJQ0IwYjNCc2FXNWxMbU5zWVhOelRHbHpkQzV5WlcxdmRtVW9YQ0ptYVhobFpGd2lLVHRjY2x4dUlDQjlJR1ZzYzJVZ2UxeHlYRzRnSUNBZ2RHOXdiR2x1WlM1amJHRnpjMHhwYzNRdVlXUmtLRndpWm1sNFpXUmNJaWs3WEhKY2JpQWdmVnh5WEc1OUtUdGNjbHh1WEhKY2JtSjFjbWRsY2k1dmJtTnNhV05ySUQwZ1pTQTlQaUI3WEhKY2JpQWdaUzV3Y21WMlpXNTBSR1ZtWVhWc2RDZ3BPMXh5WEc0Z0lHMXZZbWxzWlUxbGJuVXVZMnhoYzNOTWFYTjBMblJ2WjJkc1pTaGNJbWhwWkdWY0lpazdYSEpjYm4wN1hISmNibHh5WEc1amJHOXpaVUowYmk1dmJtTnNhV05ySUQwZ1pTQTlQaUI3WEhKY2JpQWdaUzV3Y21WMlpXNTBSR1ZtWVhWc2RDZ3BPMXh5WEc0Z0lHMXZZbWxzWlUxbGJuVXVZMnhoYzNOTWFYTjBMblJ2WjJkc1pTaGNJbWhwWkdWY0lpazdYSEpjYm4wN1hISmNibHh5WEc1dGIySnBiR1ZNYVhOMExtOXVZMnhwWTJzZ1BTQW9LU0E5UGlCN1hISmNiaUFnYlc5aWFXeGxUV1Z1ZFM1amJHRnpjMHhwYzNRdWRHOW5aMnhsS0Z3aWFHbGtaVndpS1R0Y2NseHVmVHRjY2x4dVhISmNiaTh2SUdGalkyOXlaR1Z2Ymk1aFpHUkZkbVZ1ZEV4cGMzUmxibVZ5S0Z3aVkyeHBZMnRjSWl3Z1pTQTlQaUI3WEhKY2JpOHZJQ0FnYkdWMElIUmhjbWRsZENBOUlHVXVkR0Z5WjJWME8xeHlYRzR2THlBZ0lHTnZibk4wSUd4cGMzUWdQU0JrYjJOMWJXVnVkQzVuWlhSRmJHVnRaVzUwYzBKNVEyeGhjM05PWVcxbEtGd2lhRzkzTFhkbExXUnZYMTkwWVdKc1pYUXRhWFJsYlZ3aUtUdGNjbHh1THk4Z0lDQnNaWFFnWVhKeUlEMGdXeTR1TG14cGMzUmRPMXh5WEc0dkx5QWdJR2xtSUNoMFlYSm5aWFF1WTJ4aGMzTk1hWE4wTG1OdmJuUmhhVzV6S0NkemFHOTNKeWtwSUh0Y2NseHVMeThnSUNBZ0lIUmhjbWRsZEM1amJHRnpjMHhwYzNRdWRHOW5aMnhsS0Z3aWMyaHZkMXdpS1R0Y2NseHVMeThnSUNCOUlHVnNjMlVnZTF4eVhHNHZMeUFnSUNBZ1lYSnlMbTFoY0NocElEMCtJR2t1WTJ4aGMzTk1hWE4wTG5KbGJXOTJaU2hjSW5Ob2IzZGNJaWtwTzF4eVhHNHZMeUFnSUNBZ2RHRnlaMlYwTG1Oc1lYTnpUR2x6ZEM1MGIyZG5iR1VvWENKemFHOTNYQ0lwTzF4eVhHNHZMeUFnSUgxY2NseHVMeThnZlNrN1hISmNibHh5WEc0dkx5QmpZWEprY3k1aFpHUkZkbVZ1ZEV4cGMzUmxibVZ5S0Z3aWJXOTFjMlZ2ZG1WeVhDSXNJR1VnUFQ0Z2UxeHlYRzR2THlBZ0lHTnZibk4wSUhSaGNtZGxkQ0E5SUdVdWRHRnlaMlYwTzF4eVhHNHZMeUFnSUdOdmJuTjBJR05vYVd4a2N5QTlJR05oY21SekxtTm9hV3hrY21WdU8xeHlYRzR2THlBZ0lHbG1LSFJoY21kbGRDNWpiR0Z6YzB4cGMzUXVZMjl1ZEdGcGJuTW9KMjFsZEdodlpITmZYMk5oY21RbktTa2dlMXh5WEc0dkx5QWdJQ0FnWm05eUlDaHNaWFFnYVQwd0xDQmphR2xzWkRzZ1kyaHBiR1FnUFNCamFHbHNaSE5iYVYwN0lHa3JLeWtnZTF4eVhHNHZMeUFnSUNBZ0lDQmphR2xzWkM1amJHRnpjMHhwYzNRdWNtVnRiM1psS0NkaFkzUnBkbVVuS1Z4eVhHNHZMeUFnSUNBZ2ZWeHlYRzR2THlBZ0lDQWdkR0Z5WjJWMExtTnNZWE56VEdsemRDNWhaR1FvSjJGamRHbDJaU2NwTzF4eVhHNHZMeUFnSUgwZ1pXeHpaU0J5WlhSMWNtNWNjbHh1THk4Z2ZTazdYSEpjYmx4eVhHNXlaV0ZrVFc5eVpURXViMjVqYkdsamF5QTlJQ2dwSUQwK0lIdGNjbHh1SUNCc2FYTjBSbWx5YzNRdVkyeGhjM05NYVhOMExuUnZaMmRzWlNoY0ltMXZjbVZjSWlrN1hISmNiaUFnZEdWNGRFWnBjbk4wTG1Oc1lYTnpUR2x6ZEM1MGIyZG5iR1VvWENKdGIzSmxYQ0lwTzF4eVhHNGdJSEpsWVdSTmIzSmxNUzVqYkdGemMweHBjM1F1ZEc5bloyeGxLRndpYUdsa1pHVnVYQ0lwTzF4eVhHNGdJSEpsWVdSTVpYTnpNUzVqYkdGemMweHBjM1F1ZEc5bloyeGxLRndpYUdsa1pHVnVYQ0lwTzF4eVhHNTlPMXh5WEc1Y2NseHVjbVZoWkV4bGMzTXhMbTl1WTJ4cFkyc2dQU0FvS1NBOVBpQjdYSEpjYmlBZ2JHbHpkRVpwY25OMExtTnNZWE56VEdsemRDNTBiMmRuYkdVb1hDSnRiM0psWENJcE8xeHlYRzRnSUhSbGVIUkdhWEp6ZEM1amJHRnpjMHhwYzNRdWRHOW5aMnhsS0Z3aWJXOXlaVndpS1R0Y2NseHVJQ0J5WldGa1RXOXlaVEV1WTJ4aGMzTk1hWE4wTG5SdloyZHNaU2hjSW1ocFpHUmxibHdpS1R0Y2NseHVJQ0J5WldGa1RHVnpjekV1WTJ4aGMzTk1hWE4wTG5SdloyZHNaU2hjSW1ocFpHUmxibHdpS1R0Y2NseHVmVHRjY2x4dVhISmNiaTh2SUhKbFlXUk5iM0psTWk1dmJtTnNhV05ySUQwZ0tDa2dQVDRnZTF4eVhHNHZMeUFnSUhSbGVIUlRaV052Ym1RdVkyeGhjM05NYVhOMExuUnZaMmRzWlNoY0ltMXZjbVZjSWlrN1hISmNiaTh2SUNBZ2NtVmhaRTF2Y21VeUxtTnNZWE56VEdsemRDNTBiMmRuYkdVb1hDSm9hV1JrWlc1Y0lpazdYSEpjYmk4dklDQWdjbVZoWkV4bGMzTXlMbU5zWVhOelRHbHpkQzUwYjJkbmJHVW9YQ0pvYVdSa1pXNWNJaWs3WEhKY2JpOHZJSDA3WEhKY2JseHlYRzR2THlCeVpXRmtUR1Z6Y3pJdWIyNWpiR2xqYXlBOUlDZ3BJRDArSUh0Y2NseHVMeThnSUNCMFpYaDBVMlZqYjI1a0xtTnNZWE56VEdsemRDNTBiMmRuYkdVb1hDSnRiM0psWENJcE8xeHlYRzR2THlBZ0lISmxZV1JOYjNKbE1pNWpiR0Z6YzB4cGMzUXVkRzluWjJ4bEtGd2lhR2xrWkdWdVhDSXBPMXh5WEc0dkx5QWdJSEpsWVdSTVpYTnpNaTVqYkdGemMweHBjM1F1ZEc5bloyeGxLRndpYUdsa1pHVnVYQ0lwTzF4eVhHNHZMeUI5TzF4eVhHNWNjbHh1WTI5dWMzUWdjbVZ1WkdWeVVISnZaSFZqZEhNZ1BTQnBkR1Z0SUQwK0lIdGNjbHh1SUNCeVpYUjFjbTRnWUR4a2FYWWdZMnhoYzNNOVhDSmpiMnd0TVRJZ1kyOXNMVzFrTFRZZ1kyOXNMV3huTFRSY0lqNWNjbHh1SUNBOFpHbDJJR05zWVhOelBWd2ljSEp2YW1WamRITmZYMk5oY21SY0lqNWNjbHh1SUNBZ0lEeGthWFlnWTJ4aGMzTTlYQ0p3Y205cVpXTjBjMTlmYVcxbkxYZHlZWEJ3WlhKY0lqNDhhVzFuSUhOeVl6MWNJaVI3YVhSbGJTNXpjbU45WENJZ1lXeDBQVndpYldGemExd2lQand2WkdsMlBseHlYRzRnSUNBZ1BHUnBkaUJqYkdGemN6MWNJbkJ5YjJwbFkzUnpYMTlwYm1adlhDSStYSEpjYmlBZ0lDQWdJRHhvTkNCamJHRnpjejFjSW5CeWIycGxZM1J6WDE5emRXSjBhWFJzWlZ3aVBpUjdhWFJsYlM1emRXSjBhWFJzWlgwOEwyZzBQbHh5WEc0Z0lDQWdJQ0E4Y0NCamJHRnpjejFjSW5CeWIycGxZM1J6WDE5MFpYaDBYQ0krSkh0cGRHVnRMblJsZUhSOVBDOXdQbHh5WEc0Z0lDQWdQQzlrYVhZK1hISmNiaUFnUEM5a2FYWStYSEpjYmp3dlpHbDJQbUE3WEhKY2JuMDdYSEpjYmx4eVhHNXNaWFFnY21WdVpHVnlVMlZqZEdsdmJpQTlJSEJ5YjJwbFkzUnpSR0YwWVNBOVBpQjdYSEpjYmlBZ1kyOXVjM1FnY0hKdmFtVmpkSE1nUFNCd2NtOXFaV04wYzBSaGRHRXViV0Z3S0dWc1pXMWxiblFnUFQ0Z2NtVnVaR1Z5VUhKdlpIVmpkSE1vWld4bGJXVnVkQ2twTzF4eVhHNGdJR1J2WTNWdFpXNTBMbWRsZEVWc1pXMWxiblJDZVVsa0tGd2ljSEp2YW1WamRITlNaVzVrWlhKY0lpa3VhVzV1WlhKSVZFMU1JRDBnY0hKdmFtVmpkSE11YW05cGJpaGNJbHdpS1R0Y2NseHVmVHRjY2x4dVhISmNibk5sWlUxdmNtVXViMjVqYkdsamF5QTlJR1VnUFQ0Z2UxeHlYRzRnSUdVdWNISmxkbVZ1ZEVSbFptRjFiSFFvS1R0Y2NseHVJQ0JqYjNWdWRHVnlJQ3M5SUhKaGFYTmxjanRjY2x4dUlDQnlaVzVrWlhKVFpXTjBhVzl1S0hCeWIyUjFZM1J6TG5Oc2FXTmxLREFzSUdOdmRXNTBaWElwS1R0Y2NseHVmVHRjY2x4dVhISmNibmRwYm1SdmR5NWhaR1JGZG1WdWRFeHBjM1JsYm1WeUtGd2lSRTlOUTI5dWRHVnVkRXh2WVdSbFpGd2lMQ0FvS1NBOVBpQjdYSEpjYmlBZ1kyOXVjM1FnZDJsMFpHaERiM1Z1ZEdWeUlEMGdZWE41Ym1NZ0tDa2dQVDRnZTF4eVhHNGdJQ0FnYzNkcGRHTm9JQ2gwY25WbEtTQjdYSEpjYmlBZ0lDQWdJR05oYzJVZ1pHOWpkVzFsYm5RdVpHOWpkVzFsYm5SRmJHVnRaVzUwTG1Oc2FXVnVkRmRwWkhSb0lENGdOelk0T2x4eVhHNGdJQ0FnSUNBZ0lHTnZkVzUwWlhJZ1BTQTVPMXh5WEc0Z0lDQWdJQ0FnSUdKeVpXRnJPMXh5WEc0Z0lDQWdJQ0JqWVhObElHUnZZM1Z0Wlc1MExtUnZZM1Z0Wlc1MFJXeGxiV1Z1ZEM1amJHbGxiblJYYVdSMGFDQStJRFF4TkRwY2NseHVJQ0FnSUNBZ0lDQmpiM1Z1ZEdWeUlEMGdORHRjY2x4dUlDQWdJQ0FnSUNCeVlXbHpaWElnUFNBME8xeHlYRzRnSUNBZ0lDQWdJR0p5WldGck8xeHlYRzRnSUNBZ0lDQmtaV1poZFd4ME9seHlYRzRnSUNBZ0lDQWdJR052ZFc1MFpYSWdQU0F6TzF4eVhHNGdJQ0FnSUNBZ0lISmhhWE5sY2lBOUlETTdYSEpjYmlBZ0lDQWdJQ0FnWW5KbFlXczdYSEpjYmlBZ0lDQjlYSEpjYmlBZ2ZUdGNjbHh1SUNCM2FYUmthRU52ZFc1MFpYSW9LVHRjY2x4dUlDQnlaVzVrWlhKVFpXTjBhVzl1S0hCeWIyUjFZM1J6TG5Oc2FXTmxLREFzSUdOdmRXNTBaWElwS1R0Y2NseHVmU2s3WEhKY2JpSmRmUT09In0=
